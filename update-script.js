const KintoClient = require("kinto-http").default;
const btoa = require("btoa");
const fs = require('fs/promises');
const fetch = require("node-fetch");
const AppConstants = require("./app-constants");

const RELATED_REALMS_COLLECTION_ID = "websites-with-shared-credential-backends";
const PASSWORD_RULES_COLLECTION_ID = "password-rules";
/** @type {String} */
/** @type {String} */
const AUTHORIZATION = AppConstants.AUTHORIZATION;
/** @type {String} */
const SERVER_ADDRESS = AppConstants.SERVER;
const BUCKET = "main-workspace";
const RELATED_REALMS_LEGACY_FILE = AppConstants.RELATED_REALMS_LEGACY_FILE;
const PASSWORD_RULES_API_ENDPOINT = "https://api.github.com/repos/apple/password-manager-resources/contents/quirks/password-rules.json";

/**
 * Fetches the source records from the apiEndpoint param
 *
 * Since this script should run once every two weeks, we don't need a GitHub token.
 * See also: https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting
 * @param {string} apiEndpoint either `RELATED_REALMS_API_ENDPOINT` or `PASSWORD_RULES_API_ENDPOINT`
 * @return {String[][]} The source records
 */
const getSourceRecords = async (apiEndpoint) => {
  const response = await fetch(apiEndpoint, {
    headers: {
      "Accept": "application/vnd.github.v3.raw"
    }
  });
  const data = await response.json();
  return data;
}

const arrayEquals = (a, b) => {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((val, index) => val === b[index]);
};

/**
 * Updates the existing record in the "websites-with-shared-credential-backends" Remote Settings collection with the updated data from Apple's GitHub repository
 *
 * @param {KintoClient} client KintoClient instance
 * @param {string} bucket Name of the Remote Settings bucket
 * @param {Object} newRecord Object containing the updated related realms object
 * @param {string} newRecord.id ID from the current related realms object from the Remote Settings server
 * @param {string[][]} newRecord.relatedRealms Updated related realms array from GitHub
 */
const updateRelatedRealmsRecord = async (client, bucket, newRecord) => {
  const cid = RELATED_REALMS_COLLECTION_ID;
  await client.bucket(bucket).collection(cid).updateRecord(newRecord);
  await client.bucket(bucket).collection(cid).setData({ status: "to-review" }, { patch: true });
  console.log(`Found new records, committed changes to ${cid} collection.`);
};

/**
 * Creates a new record in Remote Settings if there are no records in the WEBSITES_WITH_SHARED_CREDENTIAL_COLLECTION
 *
 * @param {KintoClient} client
 * @param {string} bucket
 */
const createRelatedRealmsRecord = async (client, bucket, sourceRecords) => {
  const cid = RELATED_REALMS_COLLECTION_ID;
  const result = await client.bucket(bucket).collection(cid).createRecord({
    relatedRealms: sourceRecords
  });
  await client.bucket(bucket).collection(cid).setData({ status: "to-review" }, { patch: true });
  console.log(`Added new record to ${cid}`, result);
};

const printSuccessMessage = () => {
  console.log("Script finished successfully!");
}

/**
 * Determines if there are new records from the GitHub source for the "websites-with-shared-credential-backends" collection
 *
 * @param {String[][]} sourceRecords Related realms from Apple's GitHub
 * @param {String[][]} destinationRecords Related realms from Remote Settings
 * @return {Boolean} `true` if there are new records, `false` if there are no new records
 */
const checkIfNewRelatedRealmsRecords = (sourceRecords, destinationRecords) => {
  let areNewRecords = false;
  if (sourceRecords.length !== destinationRecords.length) {
    areNewRecords = true;
  }
  for (let i = 0; i < sourceRecords.length; i++) {
    if (areNewRecords) {
      break;
    }
    areNewRecords = !arrayEquals(sourceRecords[i], destinationRecords[i]);
  }
  return areNewRecords;
}

/**
 * Converts the records from the "password-rules" Remote Settings collection into a Map
 * for easier comparison against the GitHub source of truth records.
 *
 * @param {Object[]} records
 * @param {string} records.Domain
 * @param {string} records[password-rules]
 * @return {Map}
 */
const passwordRulesRecordsToMap = (records) => {
  let map = new Map();
  for (let record of records) {
    let { id, Domain: domain, "password-rules": rules } = record;
    map.set(domain, { id: id, "password-rules": rules });
  }
  return map;
}

/**
 * Creates and/or updates the existing records in the "password-rules" Remote Settings collection with the updated data from Apple's GitHub repository
 *
 * @param {KintoClient} client KintoClient instance
 * @param {string} bucket Name of the Remote Settings bucket
 */
const createAndUpdateRulesRecords = async (client, bucket) => {
  let collection = client.bucket(bucket).collection(PASSWORD_RULES_COLLECTION_ID);
  let sourceRulesByDomain = await getSourceRecords(PASSWORD_RULES_API_ENDPOINT);
  let { data: remoteSettingsRecords } = await collection.listRecords();
  debugger;
  let remoteSettingsRulesByDomain = passwordRulesRecordsToMap(remoteSettingsRecords);
  let batchRecords = [];

  for (let domain in sourceRulesByDomain) {
    let passwordRules = sourceRulesByDomain[domain]["password-rules"];
    let id;
    let oldRules;
    let _record = remoteSettingsRulesByDomain.get(domain);
    if (_record) {
      id = _record.id;
      oldRules = _record["password-rules"];
    }
    if (!id) {
      let newRecord = { "Domain": domain, "password-rules": passwordRules };
      batchRecords.push(newRecord);
      console.log("Added new record to batch!", newRecord);
    }
    if (id && oldRules !== passwordRules) {
      let updatedRecord = { id, "Domain": domain, "password-rules": passwordRules };
      batchRecords.push(updatedRecord);
      console.log("Added updated record to batch!", updatedRecord);
    }

  }
  await collection.batch(batch => {
    for (let record of batchRecords) {
      if (record.id) {
        batch.updateRecord(record);
      } else {
        batch.createRecord(record);
      }
    }
  });

  await collection.setData({ status: "to-review" }, { patch: true });
  if (batchRecords.length) {
    console.log(`Found new and/or updated records, committed changes to ${PASSWORD_RULES_COLLECTION_ID} collection.`);
  } else {
    console.log(`Found no new or updated records for the ${PASSWORD_RULES_COLLECTION_ID} collection.`);
  }
};

/**
 * Creates and/or updates the existing records in the "websites-with-shared-credential-backends" Remote Settings collection
 * with the updated data from Apple's GitHub repository.
 *
 * @param {KintoClient} client
 * @param {string} bucket
 */
const createAndUpdateRelatedRealmsRecords = async (client, bucket) => {
  let { data: relatedRealmsData } = await client.bucket(bucket).collection(RELATED_REALMS_COLLECTION_ID).listRecords();
  let realmsGithubRecords = JSON.parse(await fs.readFile(RELATED_REALMS_LEGACY_FILE, 'utf8'));
  let id = relatedRealmsData[0]?.id;
  // If there is no ID from Remote Settings, we need to create a new record in the related realms collection
  if (!id) {
    await createRelatedRealmsRecord(client, bucket, realmsGithubRecords);
  } else {
    // If there is an ID, we can compare the source and destination records
    let currentRecords = relatedRealmsData[0].relatedRealms;
    let areNewRecords = checkIfNewRelatedRealmsRecords(realmsGithubRecords, currentRecords);
    // If there are new records, we need to update the data of the record using the current ID
    if (areNewRecords) {
      let newRecord = {
        id: id,
        relatedRealms: realmsGithubRecords
      };
      await updateRelatedRealmsRecord(client, bucket, newRecord)
    } else {
      console.log(`No new records! Not committing any changes to ${RELATED_REALMS_COLLECTION_ID} collection.`);
    }
  }
};

/**
 * The runner for the script.
 *
 * @return {Number} 0 for success, 1 for failure.
 */
const main = async () => {
  if (AUTHORIZATION === "") {
    console.error("No username or password set, quitting!");
    return 1;
  }
  try {
    const client = new KintoClient(SERVER_ADDRESS, {
      headers: {
        Authorization: "Basic " + btoa(AUTHORIZATION)
      }
    });

    await createAndUpdateRelatedRealmsRecords(client, BUCKET);
    await createAndUpdateRulesRecords(client, BUCKET);
  } catch (e) {
    console.error(e);
    return 1;
  }
  printSuccessMessage();
  return 0;
};

main();
