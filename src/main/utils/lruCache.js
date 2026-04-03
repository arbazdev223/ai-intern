class LRUCache {
  constructor(maxEntries = 256) {
    this.maxEntries = Number.isFinite(maxEntries) ? maxEntries : 256;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // refresh
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      // delete oldest
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

module.exports = LRUCache;
