#!/bin/bash

# Go to the directory where the script is located
cd "$(dirname "$0")"

if [ -d "venv" ]; then
  echo "Virtual environment already exists. Deleting it..."
  rm -rf venv
fi

echo "Creating virtual environment..."
python3 -m venv venv

# Ensure .env exists, if not copy from .env.example
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "Please update .env with your secrets!"
fi

OS="$(uname -s)"
if [ "$OS" = "Linux" ]; then
    echo "Do you want to setup a systemd service for automatic startup? (y/n)"
    read -r install_service
    if [[ "$install_service" =~ ^[Yy]$ ]]; then
        PROJECT_DIR=$(pwd)
        SERVICE_FILE="/etc/systemd/system/youto-alexa-skill.service"
        
        echo "Creating systemd service file..."
        sudo tee $SERVICE_FILE > /dev/null <<EOF
[Unit]
Description=YouTube Music Alexa Skill Server
After=network.target

[Service]
User=$USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/venv/bin/python server.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

        sudo systemctl daemon-reload
        sudo systemctl enable youto-alexa-skill
        
        echo "Creating easy command 'youto-alexa-skill' in /usr/local/bin..."
        sudo tee /usr/local/bin/youto-alexa-skill > /dev/null <<EOF
#!/bin/bash
if [ "\$1" = "start" ] || [ "\$1" = "stop" ] || [ "\$1" = "status" ] || [ "\$1" = "restart" ]; then
    sudo systemctl "\$1" youto-alexa-skill
else
    echo "Usage: youto-alexa-skill {start|stop|status|restart}"
fi
EOF
        sudo chmod +x /usr/local/bin/youto-alexa-skill
        
        echo "Service configured! You can now manage it with: youto-alexa-skill start | stop | status | restart"
        echo "Starting the service now..."
        youto-alexa-skill start
        exit 0
    fi
fi

echo "Starting the server..."
chmod +x start.sh
./start.sh