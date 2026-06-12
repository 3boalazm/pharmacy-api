/** اختبارات تكامل ضد Postgres حقيقي (في CI). تسلسلية (runInBand) لعزل حالة القاعدة بين الاختبارات. */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.spec.ts"],
  testTimeout: 30000,
  maxWorkers: 1,
};
