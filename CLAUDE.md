# WallStreet To-Do Service: Project Guidelines

## Project Overview
An automated investment agent that fetches market data (Price, News, Social Sentiment), analyzes it using LLM-based sentiment and technical indicators, and outputs a prioritized "To-Do" action list.

## Tech Stack
- **Runtime:** Node.js (Latest LTS)
- **Language:** TypeScript
- **Data Fetching:** Axios / Financial MCP Servers
- **Sentiment:** OpenAI/Anthropic SDKs (for NLP analysis)
- **Math/Technicals:** `technicalindicators` npm package

## Development Commands
- **Install:** `npm install`
- **Run Dev:** `npm run dev` (using ts-node)
- **Build:** `npm run build`
- **Lint:** `npm run lint`
- **Test:** `npm test`

## Project Structure
- `/src/fetchers`: Modules for API calls (Polygon, AlphaVantage, X).
- `/src/analysis`: Sentiment logic and Technical Indicator calculations.
- `/src/engine`: The "To-Do" generator logic (Weighting signals).
- `/src/types`: TypeScript interfaces for MarketData and Actions.

## Coding Patterns
- **Async/Await:** Always use try-catch blocks for API calls.
- **Functional:** Prefer pure functions for data transformation.
- **Safety:** Use `zod` for validating incoming API schemas.
- **Signals:** A "To-Do" action must include: `Ticker`, `Action (Buy/Sell/Hold)`, `Confidence (0-1)`, and `Reasoning`.

## Financial Logic Rules
- **Golden Cross:** 50-day SMA crossing above 200-day SMA is a High Priority Buy.
- **Sentiment Divergence:** If Price is UP but Social Sentiment is DOWN (-0.5), flag as "Potential Reversal/Take Profit".
- **News Velocity:** If news volume > 3x daily average, mark as "High Volatility Alert".