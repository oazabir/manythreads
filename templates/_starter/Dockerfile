# The starter app as an image, for a site that has a registry to push it to. (The deploy README of this repository does not need it: it runs the
# source from a ConfigMap on the stock Node image, because a team's apps namespace allows no builder and no root.)
FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
