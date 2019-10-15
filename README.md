# driver-truelayer

A [DataBox](https://www.databoxproject.uk) driver to stream financial data from [TrueLayer](https://truelayer.com). TrueLayer supports a series of UK banks (soon to be expanded to more countries). At the moment it has only been tested with [Monzo bank](http://monzo.com).


# Status

This is work in progress but getting better ;-).

See Issues, below.

# Authentication

If you wish to use this driver with your own TrueLayer account then:

- Sign up in https://truelayer.com and log in.
- Create a new app and set the redirect_url to `https://127.0.0.1/driver-truelayer/ui/truelayer-redirect`.
- Copy and paste `client_id` and `client_secret` into the driver and click Authorize.
- In the driver settings, choose the bank account you wish to monitor and the Refresh Interval (in minutes).

Note: (if enabled in the driver) you can use a mock bank and mock account(s)
for testing - follow the authentication flow and select 'mock bank'. 
The login screen suggests a default mock user to try.

# Data stored
This driver writes transactional event data into a store-json for later processing.

It saves the following streams of data:

1. `truelayerUserBalance`: the balance on every refresh update (30 minutes by default)
2. `truelayerUserTransactions`: detailed transactions of the monitored account.

These can then be accessed store-json API.

See truelayer types for 
[transactions](https://docs.truelayer.com/#retrieve-account-transactions)
e.g.
```
{
  "transaction_id": "03c333979b729315545816aaa365c33f",
  "timestamp": "2018-03-06T00:00:00",
  "description": "GOOGLE PLAY STORE",
  "amount": -2.99,
  "currency": "GBP",
  "transaction_type": "DEBIT",
  "transaction_category": "PURCHASE",
  "transaction_classification": [
     "Entertainment",
     "Games"
  ],
  "merchant_name": "Google play",
  "running_balance": {
    "amount": 1238.60, 
    "currency": "GBP"
  },
  "meta": {
    "bank_transaction_id": "9882ks-00js",
    "provider_transaction_category": "DEB"
  }
}
```								    ```
and
[balances](https://docs.truelayer.com/#retrieve-account-balance)
e.g. 
```
{
  "currency": "GBP",
  "available": 1161.2,
  "current": 1161.2,
  "overdraft": 1000,
  "update_timestamp": "2017-02-07T17:33:30.001222Z"
}
```

## Issues

- handle invalid access token, e.g. after restart
- handle future timezone?!
- version datasource types

- check it doesn't use credential sharing (deprecated), just 
open banking and oauth

- redirect URLs are hard-coded as https://127.0.0.1/... 
so will only work from a local browser (not the app)

- only the success flow is handled, e.g. user cancelling
authentication isn't handled (raises exception, view times out).

- the client secret is accessible - should be at least hidden
as a password field.

- there is no status visible to the user, e.g. that it has 
been configured (or not), and with which account (if any) 
after the initial authentication flow has completed.

- the authentication flow ends with a redirect to an app page
in a separate browser tab, i.e. not within the core-ui.

- there is no way to stop the driver once successfully configured
(other than uninstalling it and authenticating successfully again
with a different account). This is partly because the authentication
failures are not handled, so old authentication information is
retained and used, but an explicit option would be good.

## Databox is funded by the following grants:

```
EP/N028260/1, Databox: Privacy-Aware Infrastructure for Managing Personal Data

EP/N028260/2, Databox: Privacy-Aware Infrastructure for Managing Personal Data

EP/N014243/1, Future Everyday Interaction with the Autonomous Internet of Things

EP/M001636/1, Privacy-by-Design: Building Accountability into the Internet of Things (IoTDatabox)

EP/M02315X/1, From Human Data to Personal Experience

```
