"""Startup script — creates DB tables then launches the app."""
from app import app, db

with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5000, threaded=True)
