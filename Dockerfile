FROM node:20-slim

# ffmpeg for video processing, yt-dlp for downloading from links,
# curl+unzip to install Deno (yt-dlp needs a JS runtime for some YouTube extractions)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip curl unzip && \
    pip3 install --break-system-packages yt-dlp && \
    curl -fsSL https://deno.land/install.sh | sh && \
    rm -rf /var/lib/apt/lists/*

ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3000
CMD ["npm", "start"]
