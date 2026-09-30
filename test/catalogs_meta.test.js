// test/catalogs_meta.test.js
// Tests for dynamic metadata-level catalog fetching, product normalization,
// TTL caching, and zero hardcoded placeholders.

const test = require("node:test");
const assert = require("node:assert");

const {
  AUDIBLE_GENRE_MAP,
  getCatalogBooks,
  fetchCatalogFromAudible,
  normalizeAudibleProduct,
  startCatalogRefresher,
  stopCatalogRefresher,
  catalogCache,
} = require("../src/catalogs_meta");

test("AUDIBLE_GENRE_MAP contains mappings for core featured categories", () => {
  assert.ok(AUDIBLE_GENRE_MAP["popular & trending"]);
  assert.equal(AUDIBLE_GENRE_MAP["popular & trending"].products_sort_by, "BestSellers");

  assert.ok(AUDIBLE_GENRE_MAP["popular series"]);
  assert.equal(AUDIBLE_GENRE_MAP["popular series"].keywords, "series");

  assert.ok(AUDIBLE_GENRE_MAP["science fiction"]);
  assert.equal(AUDIBLE_GENRE_MAP["science fiction"].category_id, "18580606011");

  assert.ok(AUDIBLE_GENRE_MAP["fantasy & magic"]);
  assert.ok(AUDIBLE_GENRE_MAP["history"]);
  assert.ok(AUDIBLE_GENRE_MAP["stephen king"]);
});

test("normalizeAudibleProduct parses titles, authors, and studio square posters", () => {
  const sample = {
    title: "Project Hail Mary: A Novel",
    authors: [{ name: "Andy Weir" }],
    asin: "B08G9PRS1K",
    language: "English",
    product_images: {
      "500": "https://m.media-amazon.com/images/I/51+n8-vS1yL._SL500_.jpg",
    },
    product_desc: "A lone astronaut must save the earth from disaster.",
    release_date: "2021-05-04",
  };

  const item = normalizeAudibleProduct(sample);
  assert.ok(item);
  assert.equal(item.name, "Project Hail Mary");
  assert.equal(item.author, "Andy Weir");
  assert.equal(item.asin, "B08G9PRS1K");
  assert.equal(item.posterShape, "square");
  assert.ok(item.poster && item.poster.includes("https://m.media-amazon.com"));
  assert.equal(item.year, "2021");
  assert.equal(item.isSeries, false);
});

test("normalizeAudibleProduct extracts series name and sequence accurately", () => {
  const sample = {
    title: "The Way of Kings",
    authors: [{ name: "Brandon Sanderson" }],
    asin: "B003ZWFO7E",
    language: "English",
    series: [
      {
        title: "The Stormlight Archive",
        sequence: "1",
      },
    ],
    product_images: {
      "500": "https://m.media-amazon.com/images/I/51wX5v2vJBL._SL500_.jpg",
    },
  };

  const item = normalizeAudibleProduct(sample);
  assert.ok(item);
  assert.equal(item.seriesName, "The Stormlight Archive");
  assert.equal(item.bookNumber, 1);
});

test("normalizeAudibleProduct rejects non-English products", () => {
  const sample = {
    title: "Der Marsianer",
    authors: [{ name: "Andy Weir" }],
    language: "German",
    product_images: { "500": "https://example.com/cover.jpg" },
  };

  const item = normalizeAudibleProduct(sample);
  assert.equal(item, null, "German audiobooks should be filtered out from English catalog");
});

test("fetchCatalogFromAudible dynamically retrieves real Audible bestsellers", async () => {
  const items = await fetchCatalogFromAudible("Popular & Trending", { limitCount: 5 });
  assert.ok(Array.isArray(items), "Expected array of audiobooks");
  assert.ok(items.length >= 3, `Expected at least 3 audiobooks, got ${items.length}`);

  for (const item of items) {
    assert.ok(item.name, "Book must have a name");
    assert.ok(item.author, "Book must have an author");
    assert.equal(item.posterShape, "square", "Posters must have square aspect ratio");
    if (item.poster) {
      assert.ok(item.poster.startsWith("http"), "Poster must be a valid URL");
    }
  }
});

test("getCatalogBooks caches results in catalogCache", async () => {
  catalogCache.clear();
  const res1 = await getCatalogBooks("Science Fiction");
  assert.ok(Array.isArray(res1));
  assert.ok(res1.length > 0);

  const cached = catalogCache.get("science fiction");
  assert.ok(cached, "Results should be cached in catalogCache");
  assert.equal(cached.length, res1.length);

  // Second retrieval should be fast from cache
  const res2 = await getCatalogBooks("Science Fiction");
  assert.equal(res2, cached);
});

test("getCatalogBooks never returns hardcoded fallbacks if API fails and cache is empty", async () => {
  // Test with a completely nonsensical query that returns no products
  const fakeGenre = "xyz123nonsensegenrethatcannotexist999";
  const items = await getCatalogBooks(fakeGenre);
  assert.ok(Array.isArray(items));
  // Must be empty array, absolutely NO hardcoded placeholder books
  assert.equal(items.length, 0, "Empty or failing queries must return [] and never hardcoded fake items");
});

test("startCatalogRefresher and stopCatalogRefresher manage background timer cleanly", () => {
  startCatalogRefresher({ intervalMs: 3600000 });
  // Should not throw or crash
  stopCatalogRefresher();
  assert.ok(true);
});
