#!/bin/sh

mkdir -p ../out
cp package*.json ../out
npm pack
mv *.tgz ../out/
