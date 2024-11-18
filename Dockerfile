# Apple removed `websites-with-shared-credential-backends.json` from the tree in favour of a new file format.
# We currently don't support the new file format. In the meantime, we can use the
# `convert-shared-credential-to-legacy-format.rb` script from apple to generate the legacy file.
ARG RELATED_REALMS_LEGACY_FILE=websites-with-shared-credential-backends.json

FROM ruby:3.3 as related-realms-legacy-generator

RUN git clone https://github.com/apple/password-manager-resources

WORKDIR /password-manager-resources

ARG RELATED_REALMS_LEGACY_FILE
RUN ./tools/convert-shared-credential-to-legacy-format.rb $RELATED_REALMS_LEGACY_FILE
# Remove all other files, we only care about `RELATED_REALMS_LEGACY_FILE`
RUN mv $RELATED_REALMS_LEGACY_FILE / && rm -rf /password-manager-resources

FROM node:20-slim

# add a non-privileged user for running the application
RUN groupadd --gid 10001 app && \
    useradd -g app --uid 10001 --shell /usr/sbin/nologin --create-home --home-dir /app app

WORKDIR /app

# Install node requirements and clean up unneeded cache data
COPY package.json package.json
RUN npm install && \
    npm cache clear --force && \
    rm -rf ~app/.node-gyp

# Finally copy in the app's source file
COPY ./update-script.js /app
COPY ./app-constants.js /app
COPY ./version.json /app/version.json
COPY --from=related-realms-legacy-generator /$RELATED_REALMS_LEGACY_FILE /app/$RELATED_REALMS_LEGACY_FILE
USER app
ARG RELATED_REALMS_LEGACY_FILE
ENV RELATED_REALMS_LEGACY_FILE=$RELATED_REALMS_LEGACY_FILE
CMD ["node", "/app/update-script.js"]
