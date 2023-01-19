import cliProgress, { Bar } from "cli-progress";
import pLimit from "p-limit";
import fs from "fs";
import SpotifyWebApi from "spotify-web-api-node";
import { table } from "table";

const secrets = JSON.parse(fs.readFileSync("secrets.json", "utf8"));

console.log("fetching scrobbles from last.fm");
const tracksLFMProgress = new cliProgress.SingleBar(
  {
    format: " {bar} {percentage}% | ETA: {eta}s | {value}/{total} Pages",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
  },
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
function getScrobblesForTrack(track) {
  return (
    scrobbled[`${track.artist}@@${track.album}@@${track.name}`]?.count ?? 0
  );
}

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
  let tries = 0;
  function get() {
    tries++;
    return makeProm().catch((err) => {
      if (err && "headers" in err && err.headers["retry-after"]) {
        return new Promise((res) => {
          setTimeout(
            () => res(),
            1000 * (Number(err.headers["retry-after"]) + 1)
          );
        }).then(get);
      } else {
        throw err;
      }
    });
  }
  return get();
}

const trackIdLimit = pLimit(25);
const trackIds_ = {};
console.log("finding spotify track ids...");
const trackIdProgress = new cliProgress.SingleBar(
  {
    format:
      " {bar} {percentage}% | ETA: {eta}s | {value}/{total} Songs | {artist} - {trackName}",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
  },
  cliProgress.Presets.shades_classic
);
trackIdProgress.start(tracks.length, 0, { artist: "", trackName: "" });
let questionable = [];
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
                if (alts.length - trackAlts.length >= artists.length * 2 + 1) {
                  let degree = "";
                  if (
                    alts.length - trackAlts.length >=
                    artists.length * 3 + 1
                  ) {
                    degree = "HIGHLY ";
                  }
                  let msg = `${degree}QUESTIONABLE (${idx}/${tracks.length}) ${track.artist} ${track.album} ${track.name}`;
                  process.stdout.clearLine();
                  process.stdout.cursorTo(0);
                  process.stdout.write(msg);
                  console.log();
                  questionable.push([degree, t]);
                }
                trackIdProgress.increment({
                  artist: track.artist,
                  trackName: track.name,
                });
                if (items[0].id in trackIds_) {
                  trackIds_[items[0].id].count += track.count;
                } else {
                  trackIds_[items[0].id] = { ...track };
                }
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
        `${track.artist} ${track.album} ${track.name}`,
        { artist: track.artist, name },
        { artist: track.artist, name: name.replace(/\w*[^\w ]\w*/g, "") },
      ];

      return search(alts);
    })
  )
);
trackIdProgress.stop();
questionable.forEach(() => console.log());

let trackIds = Object.entries(trackIds_);
trackIds.sort((a, b) => b[1].count - a[1].count);
trackIds = trackIds.slice(0, 1000);
console.log("writing summary table...");
fs.writeFileSync(
  "tracks.txt",
  table(
    [
      ["Artist", "Album", "Name", "Scrobbles"],
      ...trackIds.map(([_, { artist, album, name, count }]) => [
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
trackIds = trackIds.map((e) => e[0]);

console.log("making spotify playlist...");
const playlistId = await withRetry(() =>
  spot
    .createPlaylist("Scrobbled", {
      description:
        "1000 most listened to tracks https://github.com/anthonyrota/lastfm-to-spotify",
      public: true,
    })
    .then((res) => res.body.id)
);
console.log("adding songs to spotify playlist...");
const seq = pLimit(1);
const playlistProgress = new cliProgress.SingleBar(
  {
    format:
      " {bar} {percentage}% | ETA: {eta}s | {value}/{total} Songs | {artist} - {name} [{count}]",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
  },
  cliProgress.Presets.shades_classic
);
playlistProgress.start(trackIds_.length, 0, {
  artist: "",
  album: "",
  name: "",
  count: "",
});
await Promise.all(
  trackIds.map((trackId) =>
    seq(() =>
      withRetry(() =>
        spot.addTracksToPlaylist(playlistId, [`spotify:track:${trackId}`])
      )
    ).then(() => {
      playlistProgress.increment(trackIds_[trackId]);
    })
  )
);
playlistProgress.stop();
console.log("done!");
