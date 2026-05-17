"""Startup: create DB tables then launch the server."""
from dotenv import load_dotenv
load_dotenv()

from app import app, db

with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5000, threaded=True)
