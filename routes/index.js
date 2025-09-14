var express = require('express');
var router = express.Router();

const {google} = require('googleapis');
const credentials = require('./path/to/credentials.json');

const auth = new google.auth.OAuth2(
 "622328204874-rtaelfb6rs0h0f0r7v6betb6uf6du2p2.apps.googleusercontent.com",
  "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",
  'http://localhost:3000'
);

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});

//cron job to fetch email

//get repsonse from google api

module.exports = router;
