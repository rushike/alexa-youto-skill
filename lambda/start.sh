#!/bin/bash
echo "Activating virtual environment..."
source venv/bin/activate

echo "Installing requirements..."
pip install -r requirements.txt

echo "starting alexa skill server..."
uvicorn server:app --reload