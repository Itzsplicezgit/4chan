# Use the official lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package management files first to leverage Docker cache
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the rest of your application code
COPY . .

# Render dynamically assigns a port via the PORT environment variable.
# We expose 10000 as a default standard fallback, but Render ignores this 
# and routes traffic to the port your app binds to.
EXPOSE 10000

# Start the application
CMD [ "npm", "start" ]
