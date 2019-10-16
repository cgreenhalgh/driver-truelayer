// Based on the official TrueLayer JS Client
// https://github.com/TrueLayer/truelayer-client-javascript

// General
const https = require('https');
const http = require('http');
const express = require('express');
//const request = require('request');
const bodyParser = require('body-parser');
const nonce = require('nonce-generator');
const fs = require('fs');
const dns = require('dns');

// TrueLayer
const { AuthAPIClient, DataAPIClient } = require('truelayer-client');
let TrueLayerDefaultSettings = {};
try {
  TrueLayerDefaultSettings = require('./truelayer-secret.json');
} catch (e) {
  TrueLayerDefaultSettings = {
    'client_id': '',
    'client_secret': '',
    'redirect_url': 'https://127.0.0.1/driver-truelayer/ui/truelayer-redirect',
  };
}
const permission_scopes = ['accounts', 'balance', 'transactions', 'offline_access'];
let client;

// DataBox
const databox = require('node-databox');
const DATABOX_ARBITER_ENDPOINT = process.env.DATABOX_ARBITER_ENDPOINT || 'tcp://127.0.0.1:4444';
const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT || 'tcp://127.0.0.1:5555';
const DATABOX_TESTING = !(process.env.DATABOX_VERSION);

const PORT = process.env.port || '8080';
const store = databox.NewStoreClient(DATABOX_ZMQ_ENDPOINT, DATABOX_ARBITER_ENDPOINT);

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

const token_refresh_interval = 30;  // in minutes
const DEFAULT_REFRESH_INTERVAL = 30; // in minuts
let next_data_refresh = null;
let latest_transaction_id = null;
let latest_date = null;

// Load page templates
const ui_template = fs.readFileSync('src/views/ui.html', 'utf8');
const authenticate_template = fs.readFileSync('src/views/authenticate.html', 'utf8');
const configure_template = fs.readFileSync('src/views/configure.html', 'utf8');
const saveConfiguration_template = fs.readFileSync('src/views/saveConfiguration.html', 'utf8');


// Step 1: Auth with TrueLayer
app.get('/ui', function (req, res) {
  getSettings()
    .then((settings) => {
      const { client_id, client_secret, redirect_url } = settings;
      res.type('html');
      const html = ui_template
        .replace('__CLIENT_ID__', client_id)
        .replace('__CLIENT_SECRET__', client_secret)
        .replace('__REDIRECT_URL__', redirect_url);
      res.send(html);
    });
});

// Step 2: Auth with TrueLayer
app.get('/ui/authenticate', function (req, res) {
  getSettings()
    .then((settings) => {
      const { client_id, client_secret, redirect_url } = req.query;

      // save into settings
      settings.client_id = client_id;
      settings.client_secret = client_secret;
      settings.redirect_url = redirect_url;
      setSettings(settings);

      client = new AuthAPIClient(settings);

      const authURL = client.getAuthUrl({
        redirectURI: redirect_url,
        scope: permission_scopes,
        nonce: nonce(8),
        enableMock: true, // enable mock/testing provider(s)
        enableCredentialsSharing: false, // not deprecated credential sharing
        enableCredentialsSharingDe: false,
        enableOauth: true, // yes, oauth
        enableOpenBanking: true, // yes, open banking
      });

      // Used 'target=_blank' since TrueLayer doesn't support inner html.
      res.type('html');
      console.log(authenticate_template);
      const html = authenticate_template
        .replace('__AUTH_URL__', authURL);
      res.send(html);
    });
});

// Step 3: Get token
app.get('/ui/truelayer-redirect', (req, res) => {
  getSettings()
    .then(async (settings) => {
      const { redirect_url } = settings;
      const code = req.query.code;
      const tokens = await client.exchangeCodeForToken(redirect_url, code)
        .catch((error) => {
          console.log('TrueLayer Error: ', error);
          return Promise.reject(new Error(400));
        });
      settings.tokens = tokens;
      const now = new Date();
      settings.tokens.expiration_date = new Date().setMinutes(now.getMinutes() + token_refresh_interval);

      setSettings(settings)
        .then(() => {
          res.redirect('/ui/configure');
        });
    });
});

// Step 4: Configure Driver
// (i.e. choose the Account you want to monitor; only one at the moment)
app.get('/ui/configure', async (req, res) => {
  await validate_token();
  getSettings()
    .then(async (settings) => {
      const { tokens } = settings;

      // get all accounts
      const accounts = await DataAPIClient.getAccounts(tokens.access_token);

      // list them to the user
      let accounts_html = '';
      for(const account of accounts.results) {
        const { account_id, account_type, display_name } = account;
        accounts_html += `<input type="radio" name="account" value="${account_id}"> ${display_name} (<i>${account_type}</i>)<br><br>`;
      }
      res.type('html');
      const html = configure_template
        .replace('__ACCOUNTS__', accounts_html);
      res.send(html);
    })
    .catch((error) => {
      console.log('[configure] Error ', error);
      res.status(400).send({ statusCode: 400, body: 'error in configuration.' });
    });
});

// Step 5: Parse response and save configuration
app.get('/ui/saveConfiguration', function (req, res) {
  const newAccount = req.query.account;
  const newRefreshInterval = req.query.refresh_interval;
  console.log(`account ${newAccount}, refresh interval ${newRefreshInterval}`);

  getSettings()
    .then((settings) => {
      settings.account_id = newAccount;
      settings.refresh_interval = newRefreshInterval;
      console.log('[SETTINGS]', settings);
      return setSettings(settings);
    })
    .then((settings) => {

      // Start/Restart monitoring with new settings
      refresh_balance();
      refresh_transactions();
      res.type('html');
      const html = saveConfiguration_template;
      res.send(html);
    })
    .catch((error) => {
      console.log('[saveConfiguration] Error ', error);
      res.status(400).send({ statusCode: 400, body: 'error saving configuration settings.' });
    });
});

app.get('/status', function (req, res) {
  res.send('active');
});

const balance = databox.NewDataSourceMetadata();
balance.Description = 'TrueLayer user Balance data';
balance.ContentType = 'application/json';
balance.Vendor = 'Databox Inc.';
balance.DataSourceType = 'truelayerUserBalance';
balance.DataSourceID = 'truelayerUserBalance';
balance.StoreType = 'ts/blob';

const transactions = databox.NewDataSourceMetadata();
transactions.Description = 'TrueLayer user Transactions data';
transactions.ContentType = 'application/json';
transactions.Vendor = 'Databox Inc.';
transactions.DataSourceType = 'truelayerUserTransactions';
transactions.DataSourceID = 'truelayerUserTransactions';
transactions.StoreType = 'ts/blob';

const driverSettings = databox.NewDataSourceMetadata();
driverSettings.Description = 'TrueLayer driver settings';
driverSettings.ContentType = 'application/json';
driverSettings.Vendor = 'Databox Inc.';
driverSettings.DataSourceType = 'truelayerSettings';
driverSettings.DataSourceID = 'truelayerSettings';
driverSettings.StoreType = 'kv';

store.RegisterDatasource(balance)
  .then(() => {
	console.log(`registered datasource ${balance.DataSourceID}`)
	return store.RegisterDatasource(transactions);
  })
  .then(() => {
	console.log(`registered datasource ${transactions.DataSourceID}`)
	return store.RegisterDatasource(driverSettings);
  })
  .then(() => {
	console.log(`registered datasource ${driverSettings.DataSourceID}`)
	return new Promise(function (resolve,reject) {
		// ensure core-network permissions are in place
		let lookup = function() {
			dns.resolve('api.truelayer.com', function(err, records) {
				if (err) {
					console.log("DNS lookup failed; retrying...");
					setTimeout(lookup, 1000);
					return;
				}
				console.log("DNS ok (for api.truelayer.com)");
				resolve();
			})
		}
		lookup();
	})
  })
  .then(() => {
	  return store.TSBlob.Latest( transactions.DataSourceID )
  })
  .then((latest) => {
	if (latest.length > 0) {
		latest_transaction_id = latest[0].data.transaction_id
		latest_date = new Date(latest[0].data.timestamp).toISOString().substr(0,10)
		console.log(`latest transaction_id: ${latest_transaction_id}, date: ${latest_date} (timestamp: ${latest[0].data.timestamp})`)
	} else {
		console.log(`Note: no previous transactions found`)
	}
  })
  .then(() => {
	return getSettings()
  })
  .then((settings) => {
	if (settings.client_id && settings.client_secret) {
		client = new AuthAPIClient(settings);
	} else {
		console.log(`Note: client not created - missing id or secret`)
	}
	console.log(`driver running...`, settings)
	const timer = setInterval(timer_callback, 1000 * 60);  // per minute
	timer_callback()
  })
  .catch((err) => {
    console.log('Error starting driver:' + err, err);
  });

async function getSettings() {
  const datasourceid = 'truelayerSettings';
  return new Promise((resolve, reject) => {
    store.KV.Read(datasourceid, 'settings')
      .then((settings) => {
        //console.log('[getSettings] read response = ', settings);
        if (Object.keys(settings).length === 0) {
          //return defaults
          const settings = TrueLayerDefaultSettings;
          //console.log('[getSettings] using defaults Using ----> ', settings);
          resolve(settings);
          return;
        }

        //console.log('[getSettings]', settings);
        resolve(settings);
      })
      .catch((err) => {
        const settings = TrueLayerDefaultSettings;
        console.log('Error getting settings', err);
        console.log('[getSettings] using defaults Using ----> ', settings);
        resolve(settings);
      });
  });
}

async function setSettings(settings) {
  const datasourceid = 'truelayerSettings';
  return new Promise((resolve, reject) => {
    store.KV.Write(datasourceid, 'settings', settings)
      .then(() => {
        //console.log('[setSettings] settings saved', settings);
        resolve(settings);
      })
      .catch((err) => {
        console.log('Error setting settings', err);
        reject(err);
      });
  });
}

async function save(datasourceid, data) {
  console.log('Saving TrueLayer event::', data);
  return store.TSBlob.Write(datasourceid, data)
    .then((resp) => {
      console.log('Save got response ', resp);
    })
    .catch((error) => {
      console.log('Error writing to store:', error);
    });
}

// Will check token validity and if it is due to expire, it will refresh it
async function validate_token() {
	let settings = await getSettings()
	const { tokens } = settings;

	// check with current datetime
	const now = new Date();
	if (tokens.expiration_date < now) {
 		try {
			console.log('[refreshing token]');
        		const new_token = await client.refreshAccessToken(tokens.refresh_token)
        		settings.tokens = new_token;
        		settings.tokens.expiration_date = new Date().setMinutes(now.getMinutes() + token_refresh_interval);
			await setSettings(settings);
          	} catch(error) {
	        	console.log('TrueLayer refresh token Error: ', error);
	        	throw new Error(400);
	        }
	}
}

async function timer_callback() {
	await validate_token();
	let settings = getSettings()
	let { refresh_interval } = settings;

	// check with current datetime
	const now = new Date();

	if (next_data_refresh == null ||
		next_data_refresh < now) {
		console.log(`${now.toISOString()} poll`)

        	// refresh
        	try {
			await refresh_balance();
 		} catch (err) {
			console.log(`error refreshing balance: ${err}`, err)
		}
		try {
			await refresh_transactions();
		} catch (err) {
			console.log(`error refreshing transactions: ${err}`, err)
		}
        	// plan next refresh
		if ( ! refresh_interval ) {
			refresh_interval = DEFAULT_REFRESH_INTERVAL
		} else {
			refresh_interval = Number(refresh_interval)
		}
		next_data_refresh = new Date().setMinutes(now.getMinutes() + Number(refresh_interval));
		console.log(`next refresh at ${next_data_refresh} (refresh_interval = ${JSON.stringify(refresh_interval)})`)
	}
}

async function refresh_balance() {
  return getSettings()
    .then(async (settings) => {
      const { tokens, account_id } = settings;

      console.log('[refresh_balance]');

      const balance = await DataAPIClient.getBalance(tokens.access_token, account_id);
      return save('truelayerUserBalance', balance.results[0]);
    });
}
const MAX_TRANSACTIONS = 500;

async function refresh_transactions() {
  return getSettings()
    .then(async (settings) => {
      const { tokens, account_id } = settings;

      // limit to 30 days; default is 3 months
      if (!latest_date)
        latest_date = new Date(new Date().getTime() - 1000*60*60*24*30).toISOString().substr(0,10)
      const now = new Date().toISOString();

      console.log('Refreshing transactions from: ' + latest_date.substr(0,10) + ' - ' + now.substr(0,10) );
      // apparently wants YYYY-MM-DD
      // and what about timezones that take us into tomorrow?!
      const transactions = await DataAPIClient.getTransactions(tokens.access_token, account_id, latest_date.substr(0,10), now.substr(0,10));
      console.log(`Got ${transactions.results.length} transactions since ${latest_date} (limit = ${MAX_TRANSACTIONS})`)
	// latest known?
	let latest = transactions.results.length-1
	for ( ; latest >=0 && transactions.results[latest].transaction_id != latest_transaction_id; latest-- )
		;
	if (latest < 0) {
		console.log(`could not find latest transaction ${latest_transaction_id} -keep them all`)
		latest = transactions.results.length
	} else {
		console.log(`found latest transaction at index ${latest} - ignore ${transactions.results.length-latest} known transactions`)
	}
      // reverse order
      for (let ti=Math.min(latest-1, transactions.results.length-1, MAX_TRANSACTIONS-1); ti>=0; ti--) {
        let transaction = transactions.results[ti];
        // TODO avoid re-adding the same things
        try {
		await save('truelayerUserTransactions', transaction);
		latest_transaction_id = transaction.transaction_id
		latest_date = new Date(transaction.timestamp).toISOString().substr(0,10)
	} catch (err) {
		console.log(`error saving transaction: ${err}`, err);
	}
      }
      console.log(`done adding transactions - latest is ${latest_transaction_id}, ${latest_date}`);
    });
}

//when testing, we run as http, (to prevent the need for self-signed certs etc);
if (DATABOX_TESTING) {
  console.log('[Creating TEST http server]', PORT);
  http.createServer(app).listen(PORT);
} else {
  console.log('[Creating https server]', PORT);
  const credentials = databox.GetHttpsCredentials();
  https.createServer(credentials, app).listen(PORT);
}
