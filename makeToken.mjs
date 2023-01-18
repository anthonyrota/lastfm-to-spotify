import fs from "fs";
import SpotifyWebApi from "spotify-web-api-node";
import open from "open";

const scopes = ["playlist-modify-public"];
const redirectUri = "https://example.com/callback";
const secrets = JSON.parse(fs.readFileSync("secrets.json"), "utf8");
const clientId = secrets.spotClientId;
const state = "some-state-of-my-choice";
const showDialog = true;
const responseType = "token";
const spotifyApi = new SpotifyWebApi({
  redirectUri: redirectUri,
  clientId: clientId,
});
const authorizeURL = spotifyApi.createAuthorizeURL(
  scopes,
  state,
  showDialog,
  responseType
);

open(authorizeURL);
