import pLimit from "p-limit";
import fs from "fs";
import SpotifyWebApi from "spotify-web-api-node";

let tracksLFMRaw = fs.readFileSync("tracks.json");
let tracksLFM = JSON.parse(tracksLFMRaw);

let scrobbled = {};

console.log("counting last fm scrobbles...");
tracksLFM.forEach((track) => {
  track.track.forEach((track) => {
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
});
const ordered = Object.values(scrobbled);
ordered.sort((a, b) => b.count - a.count);
let tracks = ordered.filter(({ count }) => count > 2);

const secrets = JSON.parse(fs.readFileSync("secrets.json", "utf8"));

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
  function get() {
    return makeProm().catch((err) => {
      if (err && "headers" in err && err.headers["retry-after"]) {
        return new Promise((res) => {
          setTimeout(() => res(), Number(err.headers["retry-after"]));
        }).then(get);
      } else {
        console.log(err);
      }
    });
  }
  return get();
}

(async () => {
  const seq = pLimit(10);
  const trackIds_ = Array(tracks.length);
  console.log("finding spotify track ids...");
  await Promise.all(
    tracks.map((track, idx) =>
      seq(() => {
        function search(trackAlts) {
          const { artist, album, name } = trackAlts[0];
          return withRetry(() => {
            return spot
              .searchTracks(
                album
                  ? `track:${name} artist:${artist} album:${album}`
                  : `track:${name} artist:${artist}`
              )
              .then((res) => {
                const items = res.body.tracks.items;
                if (items.length > 0) {
                  console.log(
                    `(${idx}/${tracks.length}) FOUND`,
                    track.artist,
                    track.album,
                    track.name
                  );
                  trackIds_[idx] = items[0].id;
                } else {
                  if (trackAlts.length > 1) {
                    return search(trackAlts.slice(1));
                  } else {
                    console.log(
                      `(${idx}/${tracks.length}) NOT FOUND`,
                      track.artist,
                      track.album,
                      track.name
                    );
                  }
                }
              });
          });
        }

        const artist = track.artist;
        const album = track.album.replace(/ - Single$/, "");
        const name = track.name.replace(/ \(.+\)$/, "").replace(/ \[.+\]$/, "");

        return search([
          { artist, album, name },
          {
            artist,
            album: album.replace(/ \(.+\)$/, "").replace(/ \[.+\]$/, ""),
            name,
          },
          { artist, name },
        ]);
      })
    )
  );
  const trackIds = trackIds_.filter((id) => id !== undefined);

  console.log("making spotify playlist...");
  const playlistId = await withRetry(() =>
    spot
      .createPlaylist("LastFM Top Tracks", { description: "", public: true })
      .then((res) => res.body.id)
  );
  console.log("adding songs to spotify playlist...");
  const chunkSize = 100;
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
        console.log(`${Math.min(chunkSize * (idx + 1), tracks.length)} added`);
      })
    )
  );
})();
