import os
import time
import random
import threading
from datetime import datetime, timedelta
import pytz 
from flask import Flask, render_template, request, redirect, url_for, jsonify, session
from flask_socketio import SocketIO, emit, disconnect
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_sqlalchemy import SQLAlchemy
from authlib.integrations.flask_client import OAuth
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from authlib.integrations.base_client.errors import MismatchingStateError, OAuthError
from wonderwords import RandomWord

load_dotenv()
r = RandomWord()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'dev_key')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 6 * 1024 * 1024 

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=True)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
oauth = OAuth(app)

active_user_sessions = {} 
typing_users = set()
last_message_time = {}

def get_est_time():
    tz = pytz.timezone('US/Eastern')
    return datetime.now(tz).strftime('%I:%M %p') 

def generate_hex_color():
    r = lambda: random.randint(0, 255)
    return f'#{r():02x}{r():02x}{r():02x}'.upper()

DEFAULT_COLORS = ["#FF5733", "#33FF57", "#3385FF", "#F033FF", "#33FFF5", "#F5FF33", "#FF3385", "#D4AC0D", "#A569BD"]

def generate_username():
    # Use the library to get a random adjective and a random noun
    adjective = r.word(include_parts_of_speech=["adjectives"])
    noun = r.word(include_parts_of_speech=["nouns"])
    
    # Capitalize the words for the desired username format
    return f"{adjective.capitalize()}-{noun.capitalize()}-{random.randint(100,999)}"

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    google_id = db.Column(db.String(100), unique=True)
    email = db.Column(db.String(100))
    username = db.Column(db.String(100), unique=True)
    color = db.Column(db.String(10), default=generate_hex_color)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    content = db.Column(db.Text) 
    image_data = db.Column(db.Text) 
    timestamp = db.Column(db.String(20)) 
    created_at_dt = db.Column(db.DateTime) 
    expires_at = db.Column(db.DateTime, nullable=True) 
    delete_on_disconnect = db.Column(db.Boolean, default=False)
    user = db.relationship('User', backref='messages')

def cleanup_expired_messages():
    while True:
        with app.app_context():
            now = datetime.utcnow()
            expired = Message.query.filter(Message.expires_at <= now).all()
            if expired:
                for msg in expired:
                    socketio.emit('message_expired', {'id': msg.id})
                    db.session.delete(msg)
                db.session.commit()
        time.sleep(5) 

cleanup_thread = threading.Thread(target=cleanup_expired_messages, daemon=True)
cleanup_thread.start()

# auth and routes
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1' 

CONF_URL = 'https://accounts.google.com/.well-known/openid-configuration'
google = oauth.register(
    name='google',
    client_id=os.environ.get('GOOGLE_CLIENT_ID'),
    client_secret=os.environ.get('GOOGLE_CLIENT_SECRET'),
    server_metadata_url=CONF_URL,
    client_kwargs={'scope': 'openid email'}
)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

@app.route('/login')
def login():
    REDIRECT_URI = "https://example.com/auth"
    # Allows use in github codespaces if needed
    if 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN' in os.environ:
        codespace = os.environ.get('CODESPACE_NAME')
        domain = os.environ.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN')

        redirect_uri = f"https://{codespace}-5000.{domain}/auth"
    else:
        redirect_uri = REDIRECT_URI
        
    return google.authorize_redirect(redirect_uri)

@app.route('/auth')
def auth():
    try:
        token = google.authorize_access_token()
    except (MismatchingStateError, OAuthError):
        # If the state doesn't match redirect back to login to restart the oauth flow
        return redirect(url_for('login'))

    user_info = token['userinfo']
    email = user_info['email']

    if not email.endswith('@example.org'):
        return render_template('login.html', error="Email is not authorized")

    user = User.query.filter_by(google_id=user_info['sub']).first()
    
    if not user:
        user = User(
            google_id=user_info['sub'],
            email=email,
            username=generate_username(),
            color=random.choice(DEFAULT_COLORS)
        )
        db.session.add(user)
        db.session.commit()
    
    login_user(user)
    return redirect(url_for('index'))

@app.route('/')
@login_required
def index():
    return render_template('index.html', user=current_user)

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# api

@app.route('/api/history', methods=['GET'])
@login_required
def get_history():
    now = datetime.utcnow()
    msgs = Message.query.filter(
        (Message.expires_at > now) | (Message.expires_at == None)
    ).order_by(Message.id.desc()).limit(50).all()
    
    history = []
    for m in msgs[::-1]:
        expires_str = "Never"
        if m.delete_on_disconnect:
            expires_str = "On Disconnect"
        elif m.expires_at:
            est_exp = pytz.utc.localize(m.expires_at).astimezone(pytz.timezone('US/Eastern'))
            expires_str = est_exp.strftime('%I:%M %p')

        history.append({
            'id': m.id,
            'user_id': m.user_id,
            'username': m.user.username,
            'color': m.user.color,
            'message': m.content,
            'image': m.image_data,
            'time': m.timestamp,
            'expires_str': expires_str,
            'is_mine': m.user_id == current_user.id
        })
    return jsonify(history)

@app.route('/api/message', methods=['POST'])
@login_required
def send_message():
    last_time = last_message_time.get(current_user.id, 0)
    if time.time() - last_time < 0.5:
        return jsonify({'error': 'You are typing too fast.'}), 429
    
    last_message_time[current_user.id] = time.time()

    data = request.json
    content = data.get('message', '').strip()
    image = data.get('image')
    ttl_hours = data.get('ttl')
    temp_id = data.get('temp_id') 
    
    if len(content) > 4000: return jsonify({'error': 'Message too long'}), 400
    if not content and not image: return jsonify({'error': 'Empty'}), 400
    if image and len(image) > 7_000_000: return jsonify({'error': 'Image too large'}), 413

    timestamp = get_est_time()
    now_utc = datetime.utcnow()
    expires_at = None
    delete_on_disconnect = False
    expires_str = "Unknown"
    
    if ttl_hours == "disconnect":
        delete_on_disconnect = True
        expires_str = "On Disconnect"
    else:
        try:
            hours = int(ttl_hours)
            expires_at = now_utc + timedelta(hours=hours)
            est_exp = pytz.utc.localize(expires_at).astimezone(pytz.timezone('US/Eastern'))
            expires_str = est_exp.strftime('%I:%M %p')
        except:
            expires_at = now_utc + timedelta(hours=24)
            expires_str = "24 Hours"

    new_msg = Message(
        user_id=current_user.id, 
        content=content, 
        image_data=image,
        timestamp=timestamp, 
        created_at_dt=now_utc,
        expires_at=expires_at,
        delete_on_disconnect=delete_on_disconnect
    )
    db.session.add(new_msg)
    db.session.commit()

    socketio.emit('receive_message', {
        'id': new_msg.id,
        'temp_id': temp_id, 
        'user_id': current_user.id,
        'username': current_user.username,
        'color': current_user.color,
        'message': new_msg.content,
        'image': new_msg.image_data,
        'time': new_msg.timestamp,
        'expires_str': expires_str
    })
    return jsonify({'status': 'sent'})

@app.route('/api/message/<int:msg_id>', methods=['DELETE'])
@login_required
def delete_message(msg_id):
    msg = Message.query.get_or_404(msg_id)
    if msg.user_id != current_user.id:
        return jsonify({'error': 'Unauthorized'}), 403
    
    db.session.delete(msg)
    db.session.commit()
    socketio.emit('message_expired', {'id': msg.id})
    return jsonify({'success': True})

# socketio events

@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        if current_user.id in active_user_sessions:
            emit('connection_rejected', {'message': 'ALREADY CONNECTED: You have an active session in another tab.'})
            disconnect() 
            return False
        
        active_user_sessions[current_user.id] = request.sid
        emit('update_user_count', {'count': len(active_user_sessions)}, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated and active_user_sessions.get(current_user.id) == request.sid:
        del active_user_sessions[current_user.id]
    
    if request.sid in typing_users:
        typing_users.remove(request.sid)
        emit('typing_status', {'count': len(typing_users)}, broadcast=True)

    emit('update_user_count', {'count': len(active_user_sessions)}, broadcast=True)
    
    if current_user.is_authenticated:
        msgs = Message.query.filter_by(user_id=current_user.id, delete_on_disconnect=True).all()
        ids = []
        for m in msgs:
            db.session.delete(m)
            ids.append(m.id)
        if ids:
            db.session.commit()
            for mid in ids:
                socketio.emit('message_expired', {'id': mid})

@socketio.on('start_typing')
def handle_typing():
    typing_users.add(request.sid)
    emit('typing_status', {'count': len(typing_users)}, broadcast=True)

@socketio.on('stop_typing')
def handle_stop_typing():
    if request.sid in typing_users:
        typing_users.remove(request.sid)
        emit('typing_status', {'count': len(typing_users)}, broadcast=True)

@app.route('/api/user/me', methods=['PUT'])
@login_required
def update_me():
    data = request.json
    new_username = data.get('username', current_user.username).strip()
    
    if len(new_username) > 20:
        return jsonify({'error': 'Username too long'}), 400
    
    current_user.username = new_username
    current_user.color = data.get('color', current_user.color)
    db.session.commit()

    socketio.emit('user_updated', {
        'user_id': current_user.id,
        'username': current_user.username,
        'color': current_user.color
    })
    return jsonify({'success': True})

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)