FROM node:16

RUN apt-get update
RUN apt-get install -yq --no-install-suggests --no-install-recommends xauth xvfb

WORKDIR /app
ADD src ./src
COPY package*.json binding.gyp ./

RUN npm install
# RUN npm audit fix

COPY . .
