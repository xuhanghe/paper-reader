// Imported first by a test that must not reach the Zotero desktop app: the
// local API's address is read when lib/zotero-server is first imported
process.env.ZOTERO_API_URL = "http://127.0.0.1:9/api/users/0";
