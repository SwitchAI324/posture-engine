// Static bench manifest — keyed by character id.
// Add a new bench member with one line: `name: require("./name.json"),`.
// Used instead of fs.readdirSync so Vercel bundles the JSON.
//
// Barbara is intentionally NOT here: she is never armed on a call (ambient,
// referenced-only). She lives in Host Canon §2 / the Host prompt, not the
// bench compile. Gary (her on-camera join bit) IS a bench member.
module.exports = {
  // seen
  derek:    require("./derek.json"),
  bea:      require("./bea.json"),
  chip:     require("./chip.json"),
  brent:    require("./brent.json"),
  tyler:    require("./tyler.json"),
  conrad:   require("./conrad.json"),
  // audio-only
  bonnie:   require("./bonnie.json"),
  // phantom (never appear)
  no_show:  require("./no_show.json"),
  approver: require("./approver.json"),
  it_guy:   require("./it_guy.json"),
  // join bit (activated by Barbara)
  gary:     require("./gary.json"),
};
