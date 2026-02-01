# Nexus Streaming API

Nexus is a powerful streaming aggregator backend built with NestJS. It provides centralized movie and TV show metadata aggregation, real-time scraping from multiple providers, and a robust caching layer for fast stream delivery.

## Features

- **Metadata Aggregation**: Integrated with TMDB for comprehensive movie and TV show information.
- **Provider Scrapers**: Modular scraping architecture (includes VidSrc, SuperStream, and SimpleScraper).
- **Caching**: High-performance caching using Redis to reduce API latency and scraper load.
- **Database**: MongoDB integration via Prisma for persistence.
- **Real-time Extraction**: Uses Puppeteer for dynamic stream link extraction when necessary.

## Prerequisites

Before running the application, ensure you have the following installed:

- Node.js (v18 or higher)
- npm or yarn
- MongoDB instance (local or Atlas)
- Redis server
- TMDB API Key

## Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd nexus-api
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   Create a `.env` file in the root directory and add the following variables:
   ```env
   DATABASE_URL="mongodb://localhost:27017/nexus"
   TMDB_API_KEY="your_tmdb_api_key_here"
   REDIS_HOST="localhost"
   REDIS_PORT=6379
   PORT=3000
   ```

4. **Initialize Prisma**:
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Seed the database (Optional)**:
   ```bash
   npm run prisma:seed
   ```

## Running the App

```bash
# Development mode
npm run start:dev

# Production mode
npm run start:prod
```

## API Documentation

The API endpoints include:

- `GET /movies/trending`: Fetch trending movies.
- `GET /movies/search?q=...`: Search for movies/shows.
- `GET /movies/:id`: Get detailed information for a specific item.
- `GET /streams/:id`: Get stream links for a movie.
- `GET /streams/:id/:season/:episode`: Get stream links for a TV show episode.

## License

This project is [MIT licensed](LICENSE).
