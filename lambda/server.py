import os
import ssl
import uvicorn
from fastapi import FastAPI, Request
from common import init_db
from skill import handler, get_audio_url
from dotenv import load_dotenv

# This bypasses the SSL check for the ngrok download
ssl._create_default_https_context = ssl._create_unverified_context
load_dotenv()

app = FastAPI()

@app.on_event("startup")
async def startup_event():
    init_db()
    
    port = int(os.environ.get("PORT", 8000))
    ngrok_token = os.environ.get("NGROK_TOKEN")
    ngrok_domain = os.environ.get("NGROK_DOMAIN")
    
    if ngrok_token and ngrok_domain:
        try:
            from pyngrok import ngrok
            ngrok.set_auth_token(ngrok_token)
            print("Starting ngrok tunnel...")
            public_url = ngrok.connect(port, domain=ngrok_domain).public_url
            print(f"ngrok tunnel available at: {public_url}")
        except Exception as e:
            print(f"Failed to start ngrok tunnel: {e}")
    else:
        print("NGROK_TOKEN or NGROK_DOMAIN not set, skipping ngrok tunneling.")

    print(f"Alexa Skill local server starting on port {port}...")

@app.post("/")
async def alexa_endpoint(request: Request):
    payload = await request.json()
    response = handler(payload, None)
    return response

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # url = get_audio_url("8cd6XJPjOI8")
    # print(f"url : ", url)
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
