const specs = require.context("./", true, /\.spec\.js$/).keys();

console.log(specs);
