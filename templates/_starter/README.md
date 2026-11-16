# Starter app

A very small web app that a new manythreads team uses for its first delivery: the Engineer is asked to add a page, test it, put it on a preview
address and open a pull request. It has one page (`/`), one health check (`/healthz`), one test, and no dependencies beyond Node.

```sh
node --test          # run the test
node server.mjs      # start it on http://localhost:8080  (PORT changes the port, TEAM_NAME the name shown)
```

- `server.mjs`: the whole app. A new page is one more branch in `route`.
- `test/app.test.mjs`: its test, run with `node --test`.
- `Dockerfile`: the app as an image, for a site that has a registry.
- `deploy/preview/README.md`: how the Deployer bot puts the app on the site's address. A person never needs to follow it.

The app is served from a sub-path of the site (`/apps/<team>/<app>/`), so keep every link relative (`./style.css`, never `/style.css`) and do not
rely on cookies or `localStorage`: the site keeps the app in a sandbox.

This folder is the content of the public template repository. Make your own copy of it ("Use this template" on GitHub), give your copy to manythreads
in the setup wizard's Code step, and the Engineering team works in your copy.
