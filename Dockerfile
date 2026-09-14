FROM node:20-slim

# ffmpeg for video processing, yt-dlp for downloading from links
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3000
CMD ["npm", "start"]
