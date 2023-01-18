import cliProgress, { Bar } from "cli-progress";
import pLimit from "p-limit";
import fs from "fs";
import SpotifyWebApi from "spotify-web-api-node";
import { table } from "table";

const secrets = JSON.parse(fs.readFileSync("secrets.json", "utf8"));

console.log("fetching scrobbles from last.fm");
const tracksLFMProgress = new cliProgress.SingleBar(
  {},
  cliProgress.Presets.shades_classic
);
const tracksLFM = await (async () => {
  const tracks = [];
  const to = Math.ceil(Date.now() / 1000);
  async function fetchPage(page) {
    const res = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${secrets.lastFmUser}&api_key=${secrets.lastFmKey}&limit=200&to=${to}&page=${page}&format=json`
    );
    const data = await res.json();
    data.recenttracks.track.forEach((track) => {
      tracks.push(track);
    });
    return data.recenttracks["@attr"].totalPages;
  }
  const totalPages = await fetchPage(1);
  tracksLFMProgress.start(totalPages, 1);
  const proms = [];
  for (let i = 2; i <= totalPages; i++) {
    proms.push(
      fetchPage(i).then(() => {
        tracksLFMProgress.increment();
      })
    );
  }
  await Promise.all(proms);
  tracksLFMProgress.stop();
  return tracks;
})();

let scrobbled = {};

console.log("counting last.fm scrobbles...");
tracksLFM.forEach((track) => {
  const artist = track.artist["#text"];
  const album = track.album["#text"];
  const name = track.name;
  const key = `${artist}@@${album}@@${name}`;
  if (key in scrobbled) {
    scrobbled[key].count++;
  } else {
    scrobbled[key] = { artist, album, name, count: 1 };
  }
});
const ordered = Object.values(scrobbled);
ordered.sort((a, b) => b.count - a.count);
let tracks = ordered.filter(
  ({ artist, album, name, count }) =>
    artist !== "Travi$ Scott" &&
    album !== "Chixtape 4" &&
    album !== "WLR" &&
    album !== "Donda 2" &&
    !(
      artist === "Travis Scott" &&
      (name === "A man" ||
        name === "Smoke Drink Pop - Single" ||
        name === "sdp interlude (Extended)")
    ) &&
    album !== "Lost Cause" &&
    !(artist == "Bryson Tiller" && name === "Break Bread (feat. Vory)")
);
function bold(text) {
  return `\\033[1m${text}\\033[21m`;
}
fs.writeFileSync(
  "tracks.txt",
  table(
    [
      ["Artist", "Album", "Name", "Scrobbles"],
      ...ordered.map(({ artist, album, name, count }) => [
        artist,
        album,
        name,
        count,
      ]),
    ],
    { columnDefault: { width: 26 } }
  ),
  "utf8"
);

const spot = new SpotifyWebApi({
  clientId: secrets.spotClientId,
  clientSecret: secrets.spotClientSecret,
  accessToken: secrets.spotAccessToken,
});

const chunkArray = (array, chunkSize) =>
  Array(Math.ceil(array.length / chunkSize))
    .fill()
    .map((_, index) => index * chunkSize)
    .map((begin) => array.slice(begin, begin + chunkSize));

function withRetry(makeProm) {
  let maxTries = 1000;
  let tries = 0;
  function get() {
    tries++;
    return makeProm().catch((err) => {
      if (tries == maxTries) {
        console.log(err);
        return;
      }
      if (err && "headers" in err && err.headers["retry-after"]) {
        return new Promise((res) => {
          setTimeout(() => res(), Number(err.headers["retry-after"] + 2));
        }).then(get);
      } else {
        return makeProm();
      }
    });
  }
  return get();
}

const trackIdLimit = pLimit(10);
const trackIds_ = Array(tracks.length);
console.log("finding spotify track ids...", `(${tracks.length})`);
const trackIdProgress = new cliProgress.SingleBar(
  {
    format:
      " {bar} {percentage}% | ETA: {eta}s | {value}/{total} | {artist} - {trackName}",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
  },
  cliProgress.Presets.shades_classic
);
trackIdProgress.start(tracks.length, 0, { trackName: "" });
await Promise.all(
  tracks.map((track, idx) =>
    trackIdLimit(() => {
      function search(trackAlts) {
        return withRetry(() => {
          const t = trackAlts[0];
          return spot
            .searchTracks(
              typeof t === "string"
                ? t
                : [
                    t.album && `album:"${t.album}"`,
                    t.artist && `artist:"${t.artist}"`,
                    t.name && `track:"${t.name}"`,
                  ]
                    .filter((s) => s)
                    .join(" ")
            )
            .then((res) => {
              const items = res.body.tracks.items;
              if (items.length > 0) {
                if (alts.length - trackAlts.length >= artists.length * 3 + 1) {
                  process.stdout.clearLine();
                  process.stdout.cursorTo(0);
                  process.stdout.write(
                    `QUESTIONABLE (${idx}/${tracks.length}) ${track.artist} ${track.album} ${track.name}`
                  );
                  console.log();
                }
                trackIdProgress.increment({
                  artist: track.artist,
                  trackName: track.name,
                });
                trackIds_[idx] = items[0].id;
              } else {
                if (trackAlts.length > 1) {
                  return search(trackAlts.slice(1));
                } else {
                  trackIdProgress.increment({
                    artist: track.artist,
                    trackName: track.name,
                  });
                  process.stdout.clearLine();
                  process.stdout.cursorTo(0);
                  process.stdout.write(
                    `NOT FOUND (${idx}/${tracks.length}) ${track.artist} ${track.album} ${track.name}`
                  );
                  console.log();
                }
              }
            });
        });
      }

      const artists = track.artist
        .split(/[,&]/g)
        .map((a) => a.trim())
        .map((artist) => (artist == "Salva" ? "Young Thug" : artist));
      let album;
      if (track.album == "DRIP SEASON 4EVER") {
        album = "DS4EVER";
      } else {
        album = track.album
          .replace(/ \(.+\)/g, "")
          .replace(/ \[.+\]/g, "")
          .replace(/ -.*/, "")
          .replace(/ ll$/, "");
      }
      let name = track.name
        .replace(/ \(.+\)/g, "")
        .replace(/ \[.+\]/g, "")
        .replace(/ -.*/, "");
      if (album == "TA13OO") {
        name = name.replace(/ l.*$/, "");
      }
      if (album == "Trilogy") {
        name = name.replace("Part 1", "Pt. 1").replace("Part 2", "Pt. 2");
      }
      if (
        artists[0] === "YoungBoy Never Broke Again" &&
        name === "Untouchable"
      ) {
        album = "AI Youngboy";
      }
      if (artists[0] === "Juice WRLD" && name === "Armed and Dangerous") {
        album = "Goodbye & Good Riddance";
      }

      const alts = [
        { artist: track.artist, album: track.album, name: track.name },
        ...artists.map((artist) => ({
          artist: artist,
          album,
          name,
        })),
        ...artists.map((artist) => ({
          artist: artist,
          album: album.replace(/[^\w ]/g, ""),
          name: name.replace(/[^\w ]/g, ""),
        })),
        ...artists.map((artist) => ({
          artist: artist,
          album: album.replace(/\w*[^\w ]\w*/g, ""),
          name: name.replace(/\w*[^\w ]\w*/g, ""),
        })),
        { artist: track.artist, name },
        { artist: track.artist, name: name.replace(/\w*[^\w ]\w*/g, "") },
      ];

      return search(alts);
    })
  )
);
trackIdProgress.stop();
const trackIds = [...new Set(trackIds_.filter((id) => id !== undefined))].slice(
  0,
  1000
);

console.log("making spotify playlist...", `${trackIds.length}`);
const playlistId = await withRetry(() =>
  spot
    .createPlaylist("Scrobbled", {
      description:
        "1000 most listened to tracks ordered by scrobbles https://github.com/anthonyrota/lastfm-to-spotify",
      public: true,
    })
    .then((res) => res.body.id)
);
console.log("adding songs to spotify playlist...");
const chunkSize = 100;
const seq = pLimit(1);
await Promise.all(
  chunkArray(trackIds, chunkSize).map((trackIds, idx) =>
    seq(() =>
      withRetry(() =>
        spot.addTracksToPlaylist(
          playlistId,
          trackIds.map((id) => `spotify:track:${id}`)
        )
      )
    ).then(() => {
      console.log(`${Math.min(chunkSize * (idx + 1), trackIds.length)} added`);
    })
  )
);
