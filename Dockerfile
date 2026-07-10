# Use the official lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package management files
COPY package*.json ./

# Install dependencies (safer fallback for deployment environments)
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Expose fallback port
EXPOSE 10000

# Start the application
CMD [ "npm", "start" ]
