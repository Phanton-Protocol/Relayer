process.env.VERCEL = "1";
const express = require("express");
const path = require("path");
const backend = require("../backend/src/index.js").app;

const app = express();
app.use("/api", backend);

const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));

module.exports = app;
