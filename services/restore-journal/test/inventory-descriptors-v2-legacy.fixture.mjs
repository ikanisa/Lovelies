/** Exact frozen f2 module closure plus independent canonical D1/L1 golden
 * bytes/SHA256 values. Never imported by production or deployed as a route. */
export const frozenF2SourceSHA256 = Object.freeze({
  "journal.mjs": "94146e72979f5ea6be32e44518f2ded826eb8dfa2c7f1b6915f8831fa4984730",
  "operations.mjs": "d11c69a8a95c8199762aec45b675d03ecc15d9c40db95ea618cba7969e00cdbb",
  "inventory-values.mjs": "a4fcfb0f10ba15ad180f4c78df30caf602e0df4411a1f7f578c470fddda9ce35"
});
export const legacyGoldenVectors = Object.freeze([
  {
    "kind": "descriptor",
    "name": "direct-source",
    "canonical": "{\"action\":\"put\",\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"authority\":{\"auth_epoch\":1,\"consent_created_at\":10,\"consent_expires_at\":10000,\"consent_id\":\"00000000-0000-8000-8000-000000000007\",\"policy_version\":\"photo-policy-v1\",\"purpose\":\"photo_processing\",\"session_id\":\"00000000-0000-8000-8000-000000000006\"},\"bucket\":\"QUARANTINE\",\"database_id\":\"00000000-0000-8000-8000-000000000003\",\"incarnation_id\":\"00000000-0000-8000-8000-000000000004\",\"kind\":\"direct-source\",\"object_key\":\"source/00000000-0000-8000-8000-000000000001/00000000-0000-8000-8000-000000000002/Source_v1/00000000-0000-8000-8000-000000000020\",\"operation_id\":\"00000000-0000-8000-8000-000000000010\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"payload\":{\"byte_size\":3,\"content_type\":\"image/jpeg\",\"offset_bytes\":null,\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"source_byte_size\":3,\"transfer_sha256\":null},\"project_id\":\"ltqfplqevxztlswlzexn\",\"version\":1,\"write_id\":\"00000000-0000-8000-8000-000000000020\",\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "962a727560a7600bd7ce140067a68d872342c7c35076984dae0a4b89eb2578ee"
  },
  {
    "kind": "descriptor",
    "name": "upload-chunk",
    "canonical": "{\"action\":\"put\",\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"authority\":{\"auth_epoch\":1,\"consent_created_at\":10,\"consent_expires_at\":10000,\"consent_id\":\"00000000-0000-8000-8000-000000000007\",\"policy_version\":\"photo-policy-v1\",\"purpose\":\"photo_processing\",\"session_id\":\"00000000-0000-8000-8000-000000000006\"},\"bucket\":\"QUARANTINE\",\"database_id\":\"00000000-0000-8000-8000-000000000003\",\"incarnation_id\":\"00000000-0000-8000-8000-000000000004\",\"kind\":\"upload-chunk\",\"object_key\":\"upload-chunk/00000000-0000-8000-8000-000000000001/00000000-0000-8000-8000-000000000002/262144/00000000-0000-8000-8000-000000000021\",\"operation_id\":\"00000000-0000-8000-8000-000000000011\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"payload\":{\"byte_size\":3,\"content_type\":\"image/jpeg\",\"offset_bytes\":262144,\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"source_byte_size\":262147,\"transfer_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},\"project_id\":\"ltqfplqevxztlswlzexn\",\"version\":1,\"write_id\":\"00000000-0000-8000-8000-000000000021\",\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "993deaad358a0a05f18ed24b8a6b3dc66b99174dd5638301ee4123d7ab1712d9"
  },
  {
    "kind": "descriptor",
    "name": "assembled-source",
    "canonical": "{\"action\":\"put\",\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"authority\":{\"auth_epoch\":1,\"consent_created_at\":10,\"consent_expires_at\":10000,\"consent_id\":\"00000000-0000-8000-8000-000000000007\",\"policy_version\":\"photo-policy-v1\",\"purpose\":\"photo_processing\",\"session_id\":\"00000000-0000-8000-8000-000000000006\"},\"bucket\":\"QUARANTINE\",\"database_id\":\"00000000-0000-8000-8000-000000000003\",\"incarnation_id\":\"00000000-0000-8000-8000-000000000004\",\"kind\":\"assembled-source\",\"object_key\":\"source/00000000-0000-8000-8000-000000000001/00000000-0000-8000-8000-000000000002/Source_v1/00000000-0000-8000-8000-000000000022\",\"operation_id\":\"00000000-0000-8000-8000-000000000012\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"payload\":{\"byte_size\":3,\"content_type\":\"image/jpeg\",\"offset_bytes\":null,\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"source_byte_size\":3,\"transfer_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"project_id\":\"ltqfplqevxztlswlzexn\",\"version\":1,\"write_id\":\"00000000-0000-8000-8000-000000000022\",\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "d2a9b9d17c2d33f646fd43ac7493be520bc7eb45b1ca985040bead305f9430fc"
  },
  {
    "kind": "descriptor",
    "name": "retired-upload-delete",
    "canonical": "{\"action\":\"delete\",\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"authority\":{\"cleanup_authority_hash\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"cleanup_intent_id\":\"00000000-0000-8000-8000-000000000008\",\"deletion_request_id\":null},\"bucket\":\"QUARANTINE\",\"database_id\":\"00000000-0000-8000-8000-000000000003\",\"incarnation_id\":\"00000000-0000-8000-8000-000000000004\",\"kind\":\"retired-upload-delete\",\"object_key\":\"source/00000000-0000-8000-8000-000000000001/00000000-0000-8000-8000-000000000002/Source_v1/00000000-0000-8000-8000-000000000020\",\"operation_id\":\"00000000-0000-8000-8000-000000000013\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"payload\":{\"expected_byte_size\":3,\"expected_etag\":\"\\\"old-actual-etag\\\"\",\"expected_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"target_descriptor_hash\":\"962a727560a7600bd7ce140067a68d872342c7c35076984dae0a4b89eb2578ee\",\"target_write_id\":\"00000000-0000-8000-8000-000000000020\"},\"project_id\":\"ltqfplqevxztlswlzexn\",\"version\":1,\"write_id\":\"00000000-0000-8000-8000-000000000023\",\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "20c845376be5a31b25d4a93c18981df7094aa004af27cd96bc52d7280ff8a23b"
  },
  {
    "kind": "link",
    "name": "asset-source",
    "canonical": "{\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"offset_bytes\":null,\"operation_id\":\"00000000-0000-8000-8000-000000000040\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"project_id\":\"ltqfplqevxztlswlzexn\",\"relation\":\"asset-source\",\"target_descriptor_hash\":\"962a727560a7600bd7ce140067a68d872342c7c35076984dae0a4b89eb2578ee\",\"target_write_id\":\"00000000-0000-8000-8000-000000000020\",\"version\":1,\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "40764dbbbf5b8bfd02ac0f5c6b71b5e85484d68510a5024e9054ce39aef427eb"
  },
  {
    "kind": "link",
    "name": "upload-chunk",
    "canonical": "{\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"offset_bytes\":262144,\"operation_id\":\"00000000-0000-8000-8000-000000000041\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"project_id\":\"ltqfplqevxztlswlzexn\",\"relation\":\"upload-chunk\",\"target_descriptor_hash\":\"993deaad358a0a05f18ed24b8a6b3dc66b99174dd5638301ee4123d7ab1712d9\",\"target_write_id\":\"00000000-0000-8000-8000-000000000021\",\"version\":1,\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "c7f5776c8e1079f79533b63b19762703ac12bccf9dfbdc822610bac046a7cc44"
  },
  {
    "kind": "link",
    "name": "processing-source",
    "canonical": "{\"asset_id\":\"00000000-0000-8000-8000-000000000002\",\"asset_version\":\"Source_v1\",\"offset_bytes\":null,\"operation_id\":\"00000000-0000-8000-8000-000000000042\",\"owner_id\":\"00000000-0000-8000-8000-000000000001\",\"project_id\":\"ltqfplqevxztlswlzexn\",\"relation\":\"processing-source\",\"target_descriptor_hash\":\"962a727560a7600bd7ce140067a68d872342c7c35076984dae0a4b89eb2578ee\",\"target_write_id\":\"00000000-0000-8000-8000-000000000020\",\"version\":1,\"writer_generation_id\":\"00000000-0000-8000-8000-000000000005\"}",
    "sha256": "a42df8114d8b4d7f665f6feaf06856e2261a526f7f1ca493d9b728cafa1fe5fd"
  }
]);
