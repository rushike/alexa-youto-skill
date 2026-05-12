import os
import re
import random
import threading
from dotenv import load_dotenv

from ask_sdk_core.skill_builder import SkillBuilder
from ask_sdk_core.dispatch_components import AbstractRequestHandler, AbstractExceptionHandler
from ask_sdk_core.utils import is_request_type, is_intent_name
from ask_sdk_model.interfaces.audioplayer import PlayDirective, PlayBehavior, AudioItem, Stream, StopDirective

from googleapiclient.discovery import build

from common import (
    upsert_video, increment_play_count, insert_playback_history,
    get_valid_stream, get_stream, mark_stream_loading, get_audio_url,
    get_latest_video, insert_playback_history_record, get_latest_playback_history
)

load_dotenv()

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY")

def clean_youtube_title(title):
    # 1. Remove content inside parentheses/brackets (e.g., [Official Video])
    title = re.sub(r'[\(\[].*?[\)\]]', '', title)
    
    # 2. Keep Alphanumeric, Spaces, and Devanagari range (\u0900-\u097F)
    # This removes emojis, | , ! , @, #, etc., but keeps Hindi/Marathi text
    title = re.sub(r'[^\w\s\u0900-\u097F]', ' ', title)
    
    # 3. Clean up extra whitespace
    title = " ".join(title.split())
    
    # 4. Limit to 10 words
    words = title.split()
    clean_title = " ".join(words[:10])
    
    return clean_title

def search_for_videos(query, max_results=1):
    if not YOUTUBE_API_KEY:
        print("Missing YOUTUBE_API_KEY")
        return []
        
    youtube = build("youtube", "v3", developerKey=YOUTUBE_API_KEY)
    request = youtube.search().list(
        part="snippet",
        maxResults=max_results,
        q=query,
        type="video"
    )
    response = request.execute()
    return response.get("items", [])

def bg_get_audio_url(video_id):
    try:
        get_audio_url(video_id)
    except Exception as e:
        print(f"Background get_audio_url error: {e}")

class Controller:
    @staticmethod
    def search(handler_input, query):
        items = search_for_videos(query, max_results=1)
        if not items:
            return handler_input.response_builder.speak("No matching video found").response
            
        item = items[0]
        video_id = item["id"]["videoId"]
        snippet = item["snippet"]
        
        thumbnail = None
        if "thumbnails" in snippet:
            thumbnail = snippet["thumbnails"].get("high", {}).get("url") or \
                        snippet["thumbnails"].get("default", {}).get("url")
        
        upsert_video(
            video_id=video_id,
            title=clean_youtube_title(snippet["title"]),
            channel_title=snippet["channelTitle"],
            thumbnail=thumbnail,
            query=query,
            tag="music"
        )
        
        print(f"[SEARCH RESULT] {video_id} {snippet['title']}")
        
        audio_info = {
            "id": {"videoId": video_id},
            "snippet": {"title": clean_youtube_title(snippet["title"])}
        }
        return Controller.play(handler_input, audio_info)

    @staticmethod
    def play(handler_input, audio_info):
        session_attr = handler_input.attributes_manager.session_attributes
        session_attr["lastAudioInfo"] = audio_info
        handler_input.attributes_manager.session_attributes = session_attr
        
        video_id = audio_info["id"]["videoId"]
        stream = get_stream(video_id)
        cached = get_valid_stream(video_id)
        
        if cached:
            stream_url = cached["stream_url"]
            print(f"[PLAY STREAM] {stream_url}")
            
            increment_play_count(video_id)
            insert_playback_history(video_id)
            
            return handler_input.response_builder \
                .speak(f"Playing {audio_info['snippet']['title']}") \
                .set_should_end_session(True) \
                .add_directive(PlayDirective(
                    play_behavior=PlayBehavior.REPLACE_ALL,
                    audio_item=AudioItem(
                        stream=Stream(
                            url=stream_url,
                            token=video_id,
                            offset_in_milliseconds=0
                        )
                    )
                )).response
                
        if stream and stream.get("stream_status") in ["LOADING", "FETCHING"]:
            return handler_input.response_builder \
                .speak(f"still loading the song {audio_info['snippet']['title'][:30]}, please say play now to check again.") \
                .ask("could you please say play now?") \
                .response
                
        mark_stream_loading(video_id)
        insert_playback_history_record(video_id, audio_info['snippet']['title'], status="FETCHING")
        
        # Trigger background work
        threading.Thread(target=bg_get_audio_url, args=(video_id,), daemon=True).start()
        
        return handler_input.response_builder \
            .speak(f"loading {audio_info['snippet']['title'][:40]} in memory.") \
            .ask("could you please say play now?") \
            .response

class LaunchRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("LaunchRequest")(handler_input)
    def handle(self, handler_input):
        return handler_input.response_builder \
            .speak("Welcome to youtube music, which song will you like to hear") \
            .ask("You can say, play vikram title track, to begin") \
            .response

class PlaySongIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("PlaySongIntent")(handler_input)
    def handle(self, handler_input):
        slots = handler_input.request_envelope.request.intent.slots
        query = slots["songQuery"].value if "songQuery" in slots and slots["songQuery"].value else None
        
        if query:
            return Controller.search(handler_input, query)
        else:
            return handler_input.response_builder \
                .speak("You can say, play vikram title track, to begin.") \
                .response

class PlayNowIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("PlayNowIntent")(handler_input)
    def handle(self, handler_input):
        session_attr = handler_input.attributes_manager.session_attributes
        audio_info = session_attr.get("lastAudioInfo")
        
        if not audio_info:
            latest = get_latest_playback_history()
            if latest:
                audio_info = {
                    "id": {"videoId": latest["video_id"]},
                    "snippet": {"title": latest["title"]}
                }
                
        if audio_info:
            return Controller.play(handler_input, audio_info)
        else:
            return handler_input.response_builder \
                .speak("I don't know which song to play. Please ask me to play a song first.") \
                .ask("You can say, play vikram title track.") \
                .response

class HelpIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AMAZON.HelpIntent")(handler_input)
    def handle(self, handler_input):
        speak_output = "You can say play songs by timmy trumpet?"
        return handler_input.response_builder.speak(speak_output).ask(speak_output).response

class CancelAndStopIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AMAZON.CancelIntent")(handler_input) or is_intent_name("AMAZON.StopIntent")(handler_input)
    def handle(self, handler_input):
        return handler_input.response_builder.add_directive(StopDirective()).response

class AudioPlayerEventHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return handler_input.request_envelope.request.object_type.startswith("AudioPlayer.")
    def handle(self, handler_input):
        event_name = handler_input.request_envelope.request.object_type.split(".")[1]
        print(f"AudioPlayer event: {event_name}")
        return handler_input.response_builder.response

class SystemExceptionHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("System.ExceptionEncountered")(handler_input)
    def handle(self, handler_input):
        error = handler_input.request_envelope.request.error
        print(f"System exception encountered: {error}")
        return handler_input.response_builder.response

class AudioControlIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        if not is_request_type("IntentRequest")(handler_input):
            return False
        intent_name = handler_input.request_envelope.request.intent.name
        return intent_name in [
            'AMAZON.PauseIntent', 'AMAZON.LoopOffIntent', 'AMAZON.LoopOnIntent',
            'AMAZON.NextIntent', 'AMAZON.PreviousIntent', 'AMAZON.RepeatIntent',
            'AMAZON.ShuffleOffIntent', 'AMAZON.ShuffleOnIntent', 'AMAZON.StartOverIntent'
        ]
    def handle(self, handler_input):
        intent_name = handler_input.request_envelope.request.intent.name
        print(f"Audio Control Intent: {intent_name}")
        
        if intent_name == 'AMAZON.PauseIntent':
            return handler_input.response_builder.add_directive(StopDirective()).response
            
        if intent_name == 'AMAZON.NextIntent':
            audio_player = getattr(handler_input.request_envelope.context, 'audio_player', None)
            token = audio_player.token if audio_player else None
            
            next_query = 'music'
            next_tag = 'music'
            
            if token:
                stream_info = get_stream(token)
                if stream_info:
                    if stream_info.get("query"):
                        next_query = stream_info["query"]
                    if stream_info.get("tag"):
                        next_tag = stream_info["tag"]
                        
            items = search_for_videos(next_query, max_results=10)
            if items:
                idx = random.randint(0, min(len(items)-1, 9))
                if token and items[idx]["id"]["videoId"] == token and len(items) > 1:
                    idx = (idx + 1) % min(len(items), 10)
                    
                item = items[idx]
                snippet = item["snippet"]
                thumbnail = snippet.get("thumbnails", {}).get("high", {}).get("url") or \
                            snippet.get("thumbnails", {}).get("default", {}).get("url")
                            
                upsert_video(
                    video_id=item["id"]["videoId"],
                    title=clean_youtube_title(snippet["title"]),
                    channel_title=snippet["channelTitle"],
                    thumbnail=thumbnail,
                    query=next_query,
                    tag=next_tag
                )
                
                audio_info = {
                    "id": {"videoId": item["id"]["videoId"]},
                    "snippet": {"title": clean_youtube_title(snippet["title"])}
                }
                return Controller.play(handler_input, audio_info)
            else:
                return handler_input.response_builder.speak("I couldn't find any more music to play next.").response
                
        return handler_input.response_builder.speak("I cannot do that right now.").response

class ResumeIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AMAZON.ResumeIntent")(handler_input)
    def handle(self, handler_input):
        audio_player = getattr(handler_input.request_envelope.context, 'audio_player', None)
        if audio_player and audio_player.token:
            video_id = audio_player.token
            offset = audio_player.offset_in_milliseconds or 0
            
            cached = get_valid_stream(video_id)
            if cached:
                return handler_input.response_builder \
                    .add_directive(PlayDirective(
                        play_behavior=PlayBehavior.REPLACE_ALL,
                        audio_item=AudioItem(
                            stream=Stream(
                                url=cached["stream_url"],
                                token=video_id,
                                offset_in_milliseconds=offset
                            )
                        )
                    )).response
            else:
                return handler_input.response_builder.speak('The stream has expired or is no longer available. Please ask for the song again.').response
        return handler_input.response_builder.speak("I don't have anything to resume.").response

class FallbackIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AMAZON.FallbackIntent")(handler_input)
    def handle(self, handler_input):
        speak_output = "Sorry, I don't know about that. Please try again."
        return handler_input.response_builder.speak(speak_output).ask(speak_output).response

class SessionEndedRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("SessionEndedRequest")(handler_input)
    def handle(self, handler_input):
        print(f"Session ended: {handler_input.request_envelope.request.reason}")
        return handler_input.response_builder.response

class IntentReflectorHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("IntentRequest")(handler_input)
    def handle(self, handler_input):
        intent_name = handler_input.request_envelope.request.intent.name
        speak_output = f"You just triggered {intent_name}"
        return handler_input.response_builder.speak(speak_output).response

class CatchAllExceptionHandler(AbstractExceptionHandler):
    def can_handle(self, handler_input, exception):
        return True
    def handle(self, handler_input, exception):
        print(f"Error handled: {exception}")
        speak_output = "Sorry, I had trouble doing what you asked. Please try again."
        return handler_input.response_builder.speak(speak_output).ask(speak_output).response


sb = SkillBuilder()
sb.add_request_handler(LaunchRequestHandler())
sb.add_request_handler(PlaySongIntentHandler())
sb.add_request_handler(PlayNowIntentHandler())
sb.add_request_handler(HelpIntentHandler())
sb.add_request_handler(CancelAndStopIntentHandler())
sb.add_request_handler(AudioControlIntentHandler())
sb.add_request_handler(ResumeIntentHandler())
sb.add_request_handler(AudioPlayerEventHandler())
sb.add_request_handler(SystemExceptionHandler())
sb.add_request_handler(FallbackIntentHandler())
sb.add_request_handler(SessionEndedRequestHandler())
sb.add_request_handler(IntentReflectorHandler())
sb.add_exception_handler(CatchAllExceptionHandler())

handler = sb.lambda_handler()
