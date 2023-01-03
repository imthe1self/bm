#!/bin/sh
docker build --tag bitmessage-js -f .buildbot/node/Dockerfile .
docker run -it --rm bitmessage-js:latest .buildbot/node/test.sh
