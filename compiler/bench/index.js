// Static bench manifest — keyed by character id.
// Add a new bench member with one line: `name: require("./name.json"),`.
// Used instead of fs.readdirSync so Vercel bundles the JSON.
module.exports = {
  conrad: require("./conrad.json"),
  bonnie: require("./bonnie.json"),
};
