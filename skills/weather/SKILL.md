---
name: weather
description: Fetch and display weather data from public APIs with error handling and caching
---

# Weather API Integration Skill

## Approach

This skill enables agents to fetch current weather data from public APIs and display it in a user-friendly format. It handles common weather API patterns, error scenarios, and provides caching for better performance.

## Key Patterns

### 1. API Selection & Configuration
- Use OpenWeatherMap API (free tier available)
- Store API key in context.env.OPENWEATHER_API_KEY
- Fallback to wttr.in for simple text-based weather (no API key required)
- Handle geolocation via city name or coordinates

### 2. Data Fetching Template
```js
const fetchWeather = async (location) => {
  const apiKey = context.env.OPENWEATHER_API_KEY;
  
  if (!apiKey) {
    // Fallback to wttr.in
    const response = await context.fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    return response.json();
  }
  
  // OpenWeatherMap API
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=metric`;
  const response = await context.fetch(url);
  
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
};
```

### 3. Error Handling Patterns
- Network timeouts and connectivity issues
- Invalid location names or coordinates
- API rate limiting and quota exceeded
- Malformed API responses
- Graceful degradation to cached data

### 4. Weather Display Component
```js
const WeatherDisplay = (props) => {
  const { weather, location, error } = props;
  
  if (error) {
    return `<div class="weather-error">
      <h3>Weather Unavailable</h3>
      <p>${error}</p>
    </div>`;
  }
  
  if (!weather) {
    return `<div class="weather-loading">Loading weather for ${location}...</div>`;
  }
  
  return `<div class="weather-card">
    <h2>${weather.name || location}</h2>
    <div class="weather-main">
      <span class="temperature">${Math.round(weather.main.temp)}°C</span>
      <span class="condition">${weather.weather[0].description}</span>
    </div>
    <div class="weather-details">
      <div>Feels like: ${Math.round(weather.main.feels_like)}°C</div>
      <div>Humidity: ${weather.main.humidity}%</div>
      <div>Wind: ${weather.wind.speed} m/s</div>
    </div>
  </div>`;
};
```

### 5. Caching Strategy
- Cache weather data for 10-15 minutes per location
- Store in /memory/weather_cache.json
- Include timestamp and location key
- Clear stale entries automatically

## Implementation Checklist

### Setup Phase
- [ ] Check for API key in context.env
- [ ] Set up fallback API (wttr.in) if no key available
- [ ] Create cache directory structure
- [ ] Define location parsing (city, coordinates, zip codes)

### Data Fetching
- [ ] Implement primary API call (OpenWeatherMap)
- [ ] Add fallback API implementation
- [ ] Handle all HTTP error codes (400, 401, 404, 429, 500)
- [ ] Add request timeout (5-10 seconds)
- [ ] Validate API response structure

### Caching Implementation
- [ ] Check cache before API calls
- [ ] Store successful responses with timestamps
- [ ] Implement cache expiration logic
- [ ] Handle cache file corruption
- [ ] Provide cache statistics

### UI Components
- [ ] Create weather card component
- [ ] Add loading state indicator
- [ ] Design error state display
- [ ] Include weather icons/symbols
- [ ] Make responsive for mobile

### Error Scenarios
- [ ] Network unavailable
- [ ] Invalid location input
- [ ] API key missing/invalid
- [ ] Rate limit exceeded
- [ ] Server errors (5xx)
- [ ] Malformed JSON responses

### Testing
- [ ] Test with valid locations (cities, coordinates)
- [ ] Test with invalid/nonexistent locations
- [ ] Test without API key (fallback mode)
- [ ] Test cache hit/miss scenarios
- [ ] Test error handling paths
- [ ] Verify component rendering

## Usage Examples

### Basic Weather Fetch
```js
context.emit({ type: 'progress', message: 'Fetching weather data...' });

try {
  const weather = await fetchWeather('London');
  const html = WeatherDisplay({ weather, location: 'London' });
  context.vfs.write('/artifacts/weather.html', html);
  context.emit({ type: 'result', value: weather });
} catch (error) {
  context.emit({ type: 'result', value: { error: error.message } });
}
```

### Multi-Location Weather
```js
const locations = ['New York', 'Tokyo', 'London'];
const weatherData = await Promise.allSettled(
  locations.map(loc => fetchWeather(loc))
);

const results = weatherData.map((result, i) => ({
  location: locations[i],
  weather: result.status === 'fulfilled' ? result.value : null,
  error: result.status === 'rejected' ? result.reason.message : null
}));
```

## Common Pitfalls
- Not handling API rate limits gracefully
- Forgetting to encode location names for URLs
- Not implementing proper cache invalidation
- Missing error states in UI components
- Not providing fallback for missing API keys
- Hardcoding temperature units without conversion options

## Metrics to Track
- API response times
- Cache hit/miss ratios
- Error rates by type
- Most requested locations
- API quota usage