const { searchWeb } = require("../../tools/webSearch");

function createSearchService() {
  async function search(query) {
    return searchWeb(query);
  }

  return {
    search
  };
}

module.exports = {
  createSearchService
};
