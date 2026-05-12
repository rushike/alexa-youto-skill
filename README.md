### Alexa Youtube Music Skill

Alexa does not provide native integration to neither youtube nor youtube music. This skill helps to play music from
youtube on your amazon echo device.

NOTE: The skill will not be published for public use as it can incur charges due to AWS Lambda usage.  Users who
are looking to install this skill on their echo device should have AWS developer account and then use the skill

Anyone is free to publish the skill in their AWS account so that non-tech savvy users can also make use of it. If doing
so make sure that the invocation name is changed from _youtube_ as brand names are not allowed in published skills.

If there are any already publicly available skills that plays youtube music, please feel free to add it here:

## Roadmap
1. Here we could create skill which will run it server on local system
2. Create skill through developer amazon alexa console - https://developer.amazon.com/alexa/console/ask
3. start.sh should have all command to start the local service and start port forwading through ngrok.


## Usage
1. Since you will be creating skill, this skill will never go ahead of developement, 
2. This makes you to use same account on alexa devices which you use to create skill, (inviting other account may also possible) but can't publish to internet


## Techstack
1. Youtube Data API
   1. need to search youtube video
   2. export YOUTUBE_API_KEY= from console.google.com YOU TUBE Data API
2. yt-dlp 
   1. Need to get stream url
   2. as background process
   

## Secrets Configuration
YOUTUBE_API_KEY
NGROK_DOMAIN
NGROK_TOKEN
PORT