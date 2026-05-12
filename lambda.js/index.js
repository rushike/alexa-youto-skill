import { upsertVideo, incrementPlayCount, insertPlaybackHistory, upsertStreamCache, extractExpiry, getValidStream, getStream, markStreamLoading, getAudioUrl, getLatestVideo } from "./common.js";
import Alexa from "ask-sdk-core";
import ytlist from "yt-list";
import ytdl from "@distube/ytdl-core";
import { createServer, init } from "./server.js"

import play from "play-dl";

import { YtDlp } from "ytdlp-nodejs";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

// const ytPath = execSync('which yt-dlp').toString().trim();
// console.log("ytpath : ", ytPath);

// const ytdlp = new YtDlp(ytPath);
// This is the most reliable way to force the path
// ytdlp.binaryPath = '/usr/local/bin/yt-dlp';


dotenv.config();

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speakOutput = 'Welcome to youtube music, which song will you like to hear';
        const repromptSpeakOutput = 'You can say, play vikram title track, to begin'

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(repromptSpeakOutput)
            .getResponse();
    }
};

const PlaySongIntentHandler = {
    async canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "PlaySongIntent"
        );
    },
    handle(handlerInput) {
        //console.log("Play music");
        const speechText =
            handlerInput.requestEnvelope.request.intent.slots.songQuery.value;
        if (speechText) {
            return controller.search(handlerInput, speechText);
        } else {
            return handlerInput.responseBuilder
                .speak("You can say, play vikram title track, to begin.")
                .getResponse();
        }
    },
};

const PlayNowIntentHandler = {
    canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "PlayNowIntent"
        );
    },
    handle(handlerInput) {
        const sessionAttributes = handlerInput.attributesManager.getSessionAttributes() || {};
        let audioInfo = sessionAttributes.lastAudioInfo;

        if (!audioInfo) {
            const latestVideo = getLatestVideo();
            if (latestVideo) {
                audioInfo = {
                    id: { videoId: latestVideo.video_id },
                    snippet: { title: latestVideo.title }
                };
            }
        }

        if (audioInfo) {
            return controller.play(handlerInput, audioInfo);
        } else {
            return handlerInput.responseBuilder
                .speak("I don't know which song to play. Please ask me to play a song first.")
                .reprompt("You can say, play vikram title track.")
                .getResponse();
        }
    },
};

const controller = {
    // ==============================
    // SEARCH
    // ==============================

    async search(handlerInput, query) {
        const data = await searchForVideos(query);

        const item = data.items?.[0];

        if (!item) {
            return handlerInput.responseBuilder
                .speak("No matching video found")
                .getResponse();
        }

        const videoId = item.id.videoId;

        // STORE VIDEO METADATA
        upsertVideo({
            video_id: videoId,
            title: item.snippet.title,
            channel_title: item.snippet.channelTitle,
            thumbnail:
                item.snippet.thumbnails?.high?.url ||
                item.snippet.thumbnails?.default?.url ||
                null,
            query: query,
            tag: 'music'
        });

        console.log(
            "[SEARCH RESULT]",
            videoId,
            item.snippet.title
        );

        return this.play(handlerInput, item);
    },


    // ==============================
    // PLAY
    // ==============================

    async play(handlerInput, audioInfo) {
        const { responseBuilder, attributesManager } = handlerInput;

        const sessionAttributes = attributesManager.getSessionAttributes() || {};
        sessionAttributes.lastAudioInfo = audioInfo;
        attributesManager.setSessionAttributes(sessionAttributes);

        const playBehavior = "REPLACE_ALL";

        const videoId = audioInfo.id.videoId;

        const stream = getStream(videoId);
        const cached = getValidStream(videoId);

        if (cached) {
            const streamUrl = cached.stream_url;
            console.log("[PLAY STREAM]", streamUrl);

            // UPDATE PLAY COUNT
            incrementPlayCount(videoId);

            // OPTIONAL PLAYBACK HISTORY
            insertPlaybackHistory(videoId);

            responseBuilder
                .speak(`Playing ${audioInfo.snippet.title}`)
                .withShouldEndSession(true)
                .addAudioPlayerPlayDirective(
                    playBehavior,
                    streamUrl,
                    videoId,
                    0,
                    null
                );

            return responseBuilder.getResponse();
        }

        if (stream && (stream.stream_status === 'LOADING' || stream.stream_status === 'FETCHING')) {
            return responseBuilder
                .speak("still loading the song " + audioInfo.snippet.title.slice(0, 30) + ", please say play now to check again.")
                .reprompt("could you please say play now?")
                .getResponse();
        }

        // Trigger background work
        markStreamLoading(videoId);

        getAudioUrl(videoId).catch(err => console.error("Background getAudioUrl error:", err));

        return responseBuilder
            .speak(`loading ${audioInfo.snippet.title.slice(0, 40)} in memory.`)
            .reprompt(`could you please say play now?`)
            .getResponse();
    },
    async stop(handlerInput, message) {
        return handlerInput.responseBuilder
            .speak(message)
            .addAudioPlayerStopDirective()
            .getResponse();
    },
};

const searchForVideos = async (searchQuery, nextPageToken, amount) => {
    return await ytlist.searchVideos(searchQuery, nextPageToken, amount);
}

// const getAudioUrl = async (videoId) => {
//     const audioInfo = await ytdl.getInfo(videoId, {});
//     const audioFormat = await ytdl.chooseFormat(audioInfo.formats, {
//         quality: "highestaudio",
//     });

//     const stream = await play.stream(videoUrl);
//     return { url: stream.url }; // play-dl streams provide the direct URL
//     // return audioFormat;
// };



const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can say play songs by timmy trumpet?';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .addAudioPlayerStopDirective()
            .getResponse();
    }
};

const AudioPlayerEventHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope).startsWith('AudioPlayer.');
    },
    handle(handlerInput) {
        const audioPlayerEventName = Alexa.getRequestType(handlerInput.requestEnvelope).split('.')[1];
        console.log(`AudioPlayer event: ${audioPlayerEventName}`);

        return handlerInput.responseBuilder.getResponse();
    }
};

const SystemExceptionHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'System.ExceptionEncountered';
    },
    handle(handlerInput) {
        console.log(`System exception encountered: ${JSON.stringify(handlerInput.requestEnvelope.request.error)}`);
        return handlerInput.responseBuilder.getResponse();
    }
};

const AudioControlIntentHandler = {
    canHandle(handlerInput) {
        const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
        if (requestType !== 'IntentRequest') return false;

        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        return [
            'AMAZON.PauseIntent',
            'AMAZON.LoopOffIntent',
            'AMAZON.LoopOnIntent',
            'AMAZON.NextIntent',
            'AMAZON.PreviousIntent',
            'AMAZON.RepeatIntent',
            'AMAZON.ShuffleOffIntent',
            'AMAZON.ShuffleOnIntent',
            'AMAZON.StartOverIntent'
        ].includes(intentName);
    },
    async handle(handlerInput) {
        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        console.log(`Audio Control Intent: ${intentName}`);

        if (intentName === 'AMAZON.PauseIntent') {
            return handlerInput.responseBuilder
                .addAudioPlayerStopDirective()
                .getResponse();
        }

        if (intentName === 'AMAZON.NextIntent') {
            const audioPlayer = handlerInput.requestEnvelope.context?.AudioPlayer;
            let nextQuery = 'music';
            let nextTag = 'music';
            
            if (audioPlayer && audioPlayer.token) {
                const streamInfo = getStream(audioPlayer.token);
                if (streamInfo && streamInfo.query) {
                    nextQuery = streamInfo.query;
                }
                if (streamInfo && streamInfo.tag) {
                    nextTag = streamInfo.tag;
                }
            }

            const data = await searchForVideos(nextQuery, null, 10);
            const items = data.items;
            
            if (items && items.length > 0) {
                let randomIndex = Math.floor(Math.random() * Math.min(items.length, 10));
                if (audioPlayer && audioPlayer.token && items[randomIndex].id.videoId === audioPlayer.token && items.length > 1) {
                    randomIndex = (randomIndex + 1) % Math.min(items.length, 10);
                }
                const item = items[randomIndex];
                
                upsertVideo({
                    video_id: item.id.videoId,
                    title: item.snippet.title,
                    channel_title: item.snippet.channelTitle,
                    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
                    query: nextQuery,
                    tag: nextTag
                });

                return controller.play(handlerInput, item);
            } else {
                return handlerInput.responseBuilder.speak("I couldn't find any more music to play next.").getResponse();
            }
        }

        return handlerInput.responseBuilder
            .speak('I cannot do that right now.')
            .getResponse();
    }
};

const ResumeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent';
    },
    handle(handlerInput) {
        const audioPlayer = handlerInput.requestEnvelope.context?.AudioPlayer;
        if (audioPlayer && audioPlayer.token) {
            const videoId = audioPlayer.token;
            const offset = audioPlayer.offsetInMilliseconds;

            const cached = getValidStream(videoId);
            if (cached) {
                return handlerInput.responseBuilder
                    .addAudioPlayerPlayDirective(
                        "REPLACE_ALL",
                        cached.stream_url,
                        videoId,
                        offset,
                        null
                    )
                    .getResponse();
            } else {
                return handlerInput.responseBuilder
                    .speak('The stream has expired or is no longer available. Please ask for the song again.')
                    .getResponse();
            }
        }
        return handlerInput.responseBuilder.speak("I don't have anything to resume.").getResponse();
    }
};
/* *
 * FallbackIntent triggers when a customer says something that doesn’t map to any intents in your skill
 * It must also be defined in the language model (if the locale supports it)
 * This handler can be safely added but will be ingnored in locales that do not support it yet 
 * */
const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Sorry, I don\'t know about that. Please try again.';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};
/* *
 * SessionEndedRequest notifies that a session was ended. This handler will be triggered when a currently open 
 * session is closed for one of the following reasons: 1) The user says "exit" or "quit". 2) The user does not 
 * respond or says something that does not match an intent defined in your voice model. 3) An error occurs 
 * */
const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`~~~~ Session ended: ${JSON.stringify(handlerInput.requestEnvelope)}`);
        // Any cleanup logic goes here.
        return handlerInput.responseBuilder.getResponse(); // notice we send an empty response
    }
};
/* *
 * The intent reflector is used for interaction model testing and debugging.
 * It will simply repeat the intent the user said. You can create custom handlers for your intents 
 * by defining them above, then also adding them to the request handler chain below 
 * */
const IntentReflectorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    handle(handlerInput) {
        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        const speakOutput = `You just triggered ${intentName}`;

        return handlerInput.responseBuilder
            .speak(speakOutput)
            //.reprompt('add a reprompt if you want to keep the session open for the user to respond')
            .getResponse();
    }
};
/**
 * Generic error handling to capture any syntax or routing errors. If you receive an error
 * stating the request handler chain is not found, you have not implemented a handler for
 * the intent being invoked or included it in the skill builder below 
 * */
const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
        console.log(`~~~~ Error handled: ${JSON.stringify(error)}`);

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

/**
 * This handler acts as the entry point for your skill, routing all request and response
 * payloads to the handlers above. Make sure any new handlers or interceptors you've
 * defined are included below. The order matters - they're processed top to bottom 
 * */
const skillBuilder = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        PlaySongIntentHandler,
        PlayNowIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        AudioControlIntentHandler,
        ResumeIntentHandler,
        AudioPlayerEventHandler,
        SystemExceptionHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler,
        IntentReflectorHandler)
    .addErrorHandlers(
        ErrorHandler)
    .withCustomUserAgent('sample/hello-world/v1.2')


export const hander = skillBuilder.lambda();
await init();
createServer(skillBuilder);

// const data = await searchForVideos("tera mera rista purana ");

// const item = data.items?.[0];

// if (!item) {
// return handlerInput.responseBuilder
//     .speak("No matching video found")
//     .getResponse();
// }

// const videoId = item.id.videoId;
// console.log("item : ", item);

// // STORE VIDEO METADATA
// upsertVideo({
//     video_id: videoId,
//     title: item.snippet.title,
//     channel_title: item.snippet.channelTitle,
//     thumbnail:
//         item.snippet.thumbnails?.high?.url ||
//         item.snippet.thumbnails?.default?.url ||
//         null,
// });



// GET CACHED OR REFRESHED STREAM URL
// const audioInfoData = await getAudioUrl(videoId);
// const streamUrl = audioInfoData.url;

// console.log(
//     "[PLAY STREAM]",
//     streamUrl
// );

// // UPDATE PLAY COUNT
// incrementPlayCount(videoId);

// // OPTIONAL PLAYBACK HISTORY
// insertPlaybackHistory(videoId);

// const expiresAt = extractExpiry(streamUrl);
// upsertStreamCache({
//     video_id: videoId,
//     stream_url: streamUrl,
//     mime_type: "audio/webm",
//     bitrate: null,
//     expires_at: expiresAt
// });

// ytlist.searchVideos("tmkoc 4141", null, null).then(ans => {
//     console.log("ane : ", ans);
// });

// let url = getAudioUrl('pL87j6NNwNM');
// console.log("url : ", url);
