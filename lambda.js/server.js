import { initDb } from './common.js';
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { spawn } from "node:child_process";

export async function init() {
  await initDb();
}


export const createServer = (skillBuilder) => {
  const skill = skillBuilder.create();
  // --- Express Server Wrapper ---

  const app = express();
  const port = 3000;

  
  app.use(cors());
  app.use(bodyParser.json());

  init().then(()=> {
    app.listen(port, () => {
      console.log(`Alexa Skill local server listening on port ${port}`);
    });
  });

  app.post('/', async (req, res) => {
    try {
      const response = await skill.invoke(req.body);
      res.json(response);
    } catch (error) {
      console.error(error);
      res.status(500).send('Error handling Alexa request');
    }
  });


  app.get("/youtube/audio/:id", async (req, res) => {
    try {
      const videoId = req.params.id;

      const youtubeUrl =
        `https://youtube.com/watch?v=${videoId}`;

      const ytDlp = spawn(
        "/bin/sh",
        [
          "-c",
          `/usr/local/bin/yt-dlp -f bestaudio -o - "${youtubeUrl}"`
        ]
      );

      res.setHeader(
        "Content-Type",
        "audio/webm"
      );

      ytDlp.stdout.pipe(res);

      ytDlp.stderr.on("data", (d) => {
        console.log(d.toString());
      });

      ytDlp.on("close", (code) => {
        console.log("Exited:", code);
      });

      req.on("close", () => {
        ytDlp.kill("SIGKILL");
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: err.message,
      });
    }
  });


  function getAudioUrl(videoId) {
    return new Promise((resolve, reject) => {
      const youtubeUrl =
        `https://youtube.com/watch?v=${videoId}`;

      const ytDlp = spawn(
        "/usr/local/bin/yt-dlp",
        [
          "-f",
          "bestaudio",
          "-g", // GET DIRECT URL ONLY
          youtubeUrl,
        ]
      );

      let output = "";
      let error = "";

      ytDlp.stdout.on("data", (d) => {
        output += d.toString();
      });

      ytDlp.stderr.on("data", (d) => {
        error += d.toString();
      });

      ytDlp.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(error)
          );
        }

        resolve(output.trim());
      });
    });
  }

  app.get("/youtube2/audio/:id", async (req, res) => {
    try {
      const audioUrl = await getAudioUrl(
        req.params.id
      );

      console.log(audioUrl);

      const headers = {
        "User-Agent": "Mozilla/5.0",
      };

      // IMPORTANT FOR SEEKING
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }

      const client = audioUrl.startsWith("https")
        ? https
        : http;

      client.get(
        audioUrl,
        { headers },
        (stream) => {
          res.writeHead(
            stream.statusCode,
            stream.headers
          );

          // immediate passthrough
          stream.pipe(res);
        }
      );
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: err.message,
      });
    }
  });
}


function getExpiry(url) {
  const u = new URL(url);

  const expire =
    u.searchParams.get("expire");

  return expire
    ? Number(expire) * 1000
    : Date.now() + 3600000;
}


