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

echo "Starting the server..."
chmod +x start.sh
./start.sh