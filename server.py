"""
Entry-point shim for backwards compatibility.

Delegates to ``app.main.main()`` so existing commands keep working:

    python server.py --port 7860 --open-browser
"""

from app.main import main

if __name__ == "__main__":
    main()
