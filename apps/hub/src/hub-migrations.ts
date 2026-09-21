/**
 * Interchange migrations, as data this host can carry.
 *
 * The vendored package keeps its SQL as files and reads them from disk with
 * readdir, which is right for a server process and impossible for a compiled
 * single-file host: there is no vendor directory beside the binary. These text
 * imports put the SQL in the module graph instead, so the bundler embeds it.
 *
 * This lives here, not in the vendored tree, on purpose. The vendor is upstream
 * source at a pinned revision and stays 1:1 with it; what this host needs and
 * upstream does not provide is the host own concern. The SQL itself is read
 * from the vendored files unmodified - Solutions Builder does not own the hub
 * schema and must not drift from it.
 *
 * The list is explicit because a bundler cannot glob, so it must be kept in
 * step with the directory when the vendored pin moves.
 */
export type HubMigration = { readonly id: string; readonly sql: string };

import m0000_brown_wither from "../../../vendor/interchange/packages/db/migrations/0000_brown_wither.sql" with { type: "text" };
import m0001_white_aqueduct from "../../../vendor/interchange/packages/db/migrations/0001_white_aqueduct.sql" with { type: "text" };
import m0002_clever_falcon from "../../../vendor/interchange/packages/db/migrations/0002_clever_falcon.sql" with { type: "text" };
import m0003_stiff_tyrannus from "../../../vendor/interchange/packages/db/migrations/0003_stiff_tyrannus.sql" with { type: "text" };
import m0004_rename_capability_to_offering from "../../../vendor/interchange/packages/db/migrations/0004_rename_capability_to_offering.sql" with { type: "text" };
import m0005_gigantic_cardiac from "../../../vendor/interchange/packages/db/migrations/0005_gigantic_cardiac.sql" with { type: "text" };
import m0006_sidecar from "../../../vendor/interchange/packages/db/migrations/0006_sidecar.sql" with { type: "text" };
import m0007_agent_running_session from "../../../vendor/interchange/packages/db/migrations/0007_agent_running_session.sql" with { type: "text" };
import m0008_session from "../../../vendor/interchange/packages/db/migrations/0008_session.sql" with { type: "text" };
import m0009_session_messages from "../../../vendor/interchange/packages/db/migrations/0009_session_messages.sql" with { type: "text" };
import m0010_agent_sidecar_pubkey from "../../../vendor/interchange/packages/db/migrations/0010_agent_sidecar_pubkey.sql" with { type: "text" };
import m0011_session_message_from from "../../../vendor/interchange/packages/db/migrations/0011_session_message_from.sql" with { type: "text" };
import m0012_agent_instance from "../../../vendor/interchange/packages/db/migrations/0012_agent_instance.sql" with { type: "text" };
import m0013_instance_session_id from "../../../vendor/interchange/packages/db/migrations/0013_instance_session_id.sql" with { type: "text" };
import m0014_drop_agent_runtime_columns from "../../../vendor/interchange/packages/db/migrations/0014_drop_agent_runtime_columns.sql" with { type: "text" };
import m0015_add_instance_id_to_session_message from "../../../vendor/interchange/packages/db/migrations/0015_add_instance_id_to_session_message.sql" with { type: "text" };
import m0016_jazzy_gamma_corps from "../../../vendor/interchange/packages/db/migrations/0016_jazzy_gamma_corps.sql" with { type: "text" };
import m0017_hesitant_marvex from "../../../vendor/interchange/packages/db/migrations/0017_hesitant_marvex.sql" with { type: "text" };
import m0018_natural_sinister_six from "../../../vendor/interchange/packages/db/migrations/0018_natural_sinister_six.sql" with { type: "text" };
import m0019_rename_grant_source_to_origin from "../../../vendor/interchange/packages/db/migrations/0019_rename_grant_source_to_origin.sql" with { type: "text" };
import m0020_add_agent_role from "../../../vendor/interchange/packages/db/migrations/0020_add_agent_role.sql" with { type: "text" };
import m0021_acoustic_ozymandias from "../../../vendor/interchange/packages/db/migrations/0021_acoustic_ozymandias.sql" with { type: "text" };
import m0022_material_sleepwalker from "../../../vendor/interchange/packages/db/migrations/0022_material_sleepwalker.sql" with { type: "text" };
import m0023_flawless_scarlet_witch from "../../../vendor/interchange/packages/db/migrations/0023_flawless_scarlet_witch.sql" with { type: "text" };
import m0024_bumpy_sharon_ventura from "../../../vendor/interchange/packages/db/migrations/0024_bumpy_sharon_ventura.sql" with { type: "text" };
import m0025_curvy_firestar from "../../../vendor/interchange/packages/db/migrations/0025_curvy_firestar.sql" with { type: "text" };
import m0026_keen_ultimo from "../../../vendor/interchange/packages/db/migrations/0026_keen_ultimo.sql" with { type: "text" };
import m0027_git_tokens from "../../../vendor/interchange/packages/db/migrations/0027_git_tokens.sql" with { type: "text" };
import m0028_wet_sugar_man from "../../../vendor/interchange/packages/db/migrations/0028_wet_sugar_man.sql" with { type: "text" };
import m0029_loose_warlock from "../../../vendor/interchange/packages/db/migrations/0029_loose_warlock.sql" with { type: "text" };
import m0030_session_asset_audit_split from "../../../vendor/interchange/packages/db/migrations/0030_session_asset_audit_split.sql" with { type: "text" };
import m0031_gigantic_nicolaos from "../../../vendor/interchange/packages/db/migrations/0031_gigantic_nicolaos.sql" with { type: "text" };
import m0032_lethal_misty_knight from "../../../vendor/interchange/packages/db/migrations/0032_lethal_misty_knight.sql" with { type: "text" };
import m0033_old_payback from "../../../vendor/interchange/packages/db/migrations/0033_old_payback.sql" with { type: "text" };
import m0034_sleepy_songbird from "../../../vendor/interchange/packages/db/migrations/0034_sleepy_songbird.sql" with { type: "text" };
import m0035_violet_giant_man from "../../../vendor/interchange/packages/db/migrations/0035_violet_giant_man.sql" with { type: "text" };
import m0036_sharp_the_executioner from "../../../vendor/interchange/packages/db/migrations/0036_sharp_the_executioner.sql" with { type: "text" };
import m0037_credential_use_backfill from "../../../vendor/interchange/packages/db/migrations/0037_credential_use_backfill.sql" with { type: "text" };
import m0038_chilly_blacklash from "../../../vendor/interchange/packages/db/migrations/0038_chilly_blacklash.sql" with { type: "text" };
import m0039_quick_carnage from "../../../vendor/interchange/packages/db/migrations/0039_quick_carnage.sql" with { type: "text" };
import m0040_reshape_approval_origin from "../../../vendor/interchange/packages/db/migrations/0040_reshape_approval_origin.sql" with { type: "text" };
import m0041_make_approval_timeout_at_nullable from "../../../vendor/interchange/packages/db/migrations/0041_make_approval_timeout_at_nullable.sql" with { type: "text" };
import m0042_youthful_mantis from "../../../vendor/interchange/packages/db/migrations/0042_youthful_mantis.sql" with { type: "text" };
import m0043_signal_correlation_deployment_fk from "../../../vendor/interchange/packages/db/migrations/0043_signal_correlation_deployment_fk.sql" with { type: "text" };
import m0044_model_offering_quirks from "../../../vendor/interchange/packages/db/migrations/0044_model_offering_quirks.sql" with { type: "text" };
import m0045_create_workflow_run from "../../../vendor/interchange/packages/db/migrations/0045_create_workflow_run.sql" with { type: "text" };
import m0046_approval_signal_correlation_run_fk from "../../../vendor/interchange/packages/db/migrations/0046_approval_signal_correlation_run_fk.sql" with { type: "text" };
import m0047_create_workflow_definition from "../../../vendor/interchange/packages/db/migrations/0047_create_workflow_definition.sql" with { type: "text" };
import m0048_workflow_definition_origin_agent_id from "../../../vendor/interchange/packages/db/migrations/0048_workflow_definition_origin_agent_id.sql" with { type: "text" };
import m0049_curly_omega_flight from "../../../vendor/interchange/packages/db/migrations/0049_curly_omega_flight.sql" with { type: "text" };
import m0050_late_crystal from "../../../vendor/interchange/packages/db/migrations/0050_late_crystal.sql" with { type: "text" };
import m0051_funny_madelyne_pryor from "../../../vendor/interchange/packages/db/migrations/0051_funny_madelyne_pryor.sql" with { type: "text" };
import m0052_drop_inference_turn_instance_fk from "../../../vendor/interchange/packages/db/migrations/0052_drop_inference_turn_instance_fk.sql" with { type: "text" };
import m0053_session_mail_session_id_index from "../../../vendor/interchange/packages/db/migrations/0053_session_mail_session_id_index.sql" with { type: "text" };
import m0054_rekey_instance_grants_to_workflow_run from "../../../vendor/interchange/packages/db/migrations/0054_rekey_instance_grants_to_workflow_run.sql" with { type: "text" };
import m0055_backfill_anchor_workflow_runs from "../../../vendor/interchange/packages/db/migrations/0055_backfill_anchor_workflow_runs.sql" with { type: "text" };
import m0056_repoint_deployment_fks_to_anchor_run from "../../../vendor/interchange/packages/db/migrations/0056_repoint_deployment_fks_to_anchor_run.sql" with { type: "text" };
import m0057_drop_workflow_deployment_projection from "../../../vendor/interchange/packages/db/migrations/0057_drop_workflow_deployment_projection.sql" with { type: "text" };
import m0058_repoint_offering_fk_to_definition from "../../../vendor/interchange/packages/db/migrations/0058_repoint_offering_fk_to_definition.sql" with { type: "text" };
import m0059_repoint_transaction_fk_to_run from "../../../vendor/interchange/packages/db/migrations/0059_repoint_transaction_fk_to_run.sql" with { type: "text" };
import m0060_drop_session_mail_instance_fk from "../../../vendor/interchange/packages/db/migrations/0060_drop_session_mail_instance_fk.sql" with { type: "text" };
import m0061_drop_session_asset_instance_fk from "../../../vendor/interchange/packages/db/migrations/0061_drop_session_asset_instance_fk.sql" with { type: "text" };
import m0062_drop_agent_asset_table from "../../../vendor/interchange/packages/db/migrations/0062_drop_agent_asset_table.sql" with { type: "text" };
import m0063_repoint_agent_role_fk_to_definition from "../../../vendor/interchange/packages/db/migrations/0063_repoint_agent_role_fk_to_definition.sql" with { type: "text" };
import m0064_repoint_agent_session_fk_to_definition from "../../../vendor/interchange/packages/db/migrations/0064_repoint_agent_session_fk_to_definition.sql" with { type: "text" };
import m0065_add_workflow_definition_model_requirements from "../../../vendor/interchange/packages/db/migrations/0065_add_workflow_definition_model_requirements.sql" with { type: "text" };
import m0066_rekey_agent_definition_principals_to_workflow from "../../../vendor/interchange/packages/db/migrations/0066_rekey_agent_definition_principals_to_workflow.sql" with { type: "text" };
import m0067_add_workflow_definition_kind from "../../../vendor/interchange/packages/db/migrations/0067_add_workflow_definition_kind.sql" with { type: "text" };
import m0068_drop_agent_tables_and_origin_agent_id from "../../../vendor/interchange/packages/db/migrations/0068_drop_agent_tables_and_origin_agent_id.sql" with { type: "text" };
import m0069_drop_workflow_definition_kind from "../../../vendor/interchange/packages/db/migrations/0069_drop_workflow_definition_kind.sql" with { type: "text" };
import m0070_flashy_proteus from "../../../vendor/interchange/packages/db/migrations/0070_flashy_proteus.sql" with { type: "text" };
import m0072_add_workflow_definition_credential_bindings from "../../../vendor/interchange/packages/db/migrations/0072_add_workflow_definition_credential_bindings.sql" with { type: "text" };
import m0073_grant_target_exactly_one_check from "../../../vendor/interchange/packages/db/migrations/0073_grant_target_exactly_one_check.sql" with { type: "text" };
import m0074_add_provider_api_base_url from "../../../vendor/interchange/packages/db/migrations/0074_add_provider_api_base_url.sql" with { type: "text" };
import m0075_workflow_run_launch_spec from "../../../vendor/interchange/packages/db/migrations/0075_workflow_run_launch_spec.sql" with { type: "text" };
import m0076_sidecar_allocation from "../../../vendor/interchange/packages/db/migrations/0076_sidecar_allocation.sql" with { type: "text" };
import m0077_workflow_run_dispatch from "../../../vendor/interchange/packages/db/migrations/0077_workflow_run_dispatch.sql" with { type: "text" };
import m0078_workflow_run_dispatch_kind from "../../../vendor/interchange/packages/db/migrations/0078_workflow_run_dispatch_kind.sql" with { type: "text" };
import m0079_rename_workflow_run_deployment_id_to_anchor_run_id from "../../../vendor/interchange/packages/db/migrations/0079_rename_workflow_run_deployment_id_to_anchor_run_id.sql" with { type: "text" };
import m0080_rename_correlation_approval_deployment_id_to_anchor_run_id from "../../../vendor/interchange/packages/db/migrations/0080_rename_correlation_approval_deployment_id_to_anchor_run_id.sql" with { type: "text" };
import m0081_workflow_definition_content_hash_and_approved_wire_hash from "../../../vendor/interchange/packages/db/migrations/0081_workflow_definition_content_hash_and_approved_wire_hash.sql" with { type: "text" };
import m0082_blue_black_queen from "../../../vendor/interchange/packages/db/migrations/0082_blue_black_queen.sql" with { type: "text" };
import m0083_replace_launch_spec_snapshot_with_frozen_bundle from "../../../vendor/interchange/packages/db/migrations/0083_replace_launch_spec_snapshot_with_frozen_bundle.sql" with { type: "text" };
import m0084_delete_orphaned_credential_grants from "../../../vendor/interchange/packages/db/migrations/0084_delete_orphaned_credential_grants.sql" with { type: "text" };
import m0085_add_approval_run_idx from "../../../vendor/interchange/packages/db/migrations/0085_add_approval_run_idx.sql" with { type: "text" };
import m0086_cool_human_cannonball from "../../../vendor/interchange/packages/db/migrations/0086_cool_human_cannonball.sql" with { type: "text" };
import m0087_drop_sidecar_placement from "../../../vendor/interchange/packages/db/migrations/0087_drop_sidecar_placement.sql" with { type: "text" };
import m0088_thick_sprite from "../../../vendor/interchange/packages/db/migrations/0088_thick_sprite.sql" with { type: "text" };
import m0089_tense_selene from "../../../vendor/interchange/packages/db/migrations/0089_tense_selene.sql" with { type: "text" };
import m0090_tenant_domain_lower_unique from "../../../vendor/interchange/packages/db/migrations/0090_tenant_domain_lower_unique.sql" with { type: "text" };
import m0091_workflow_run_dispatch_sender_address from "../../../vendor/interchange/packages/db/migrations/0091_workflow_run_dispatch_sender_address.sql" with { type: "text" };
import m0092_sidecar_destroy_failed from "../../../vendor/interchange/packages/db/migrations/0092_sidecar_destroy_failed.sql" with { type: "text" };

export const HUB_MIGRATIONS: readonly HubMigration[] = [
  { id: "0000_brown_wither.sql", sql: m0000_brown_wither },
  { id: "0001_white_aqueduct.sql", sql: m0001_white_aqueduct },
  { id: "0002_clever_falcon.sql", sql: m0002_clever_falcon },
  { id: "0003_stiff_tyrannus.sql", sql: m0003_stiff_tyrannus },
  { id: "0004_rename_capability_to_offering.sql", sql: m0004_rename_capability_to_offering },
  { id: "0005_gigantic_cardiac.sql", sql: m0005_gigantic_cardiac },
  { id: "0006_sidecar.sql", sql: m0006_sidecar },
  { id: "0007_agent_running_session.sql", sql: m0007_agent_running_session },
  { id: "0008_session.sql", sql: m0008_session },
  { id: "0009_session_messages.sql", sql: m0009_session_messages },
  { id: "0010_agent_sidecar_pubkey.sql", sql: m0010_agent_sidecar_pubkey },
  { id: "0011_session_message_from.sql", sql: m0011_session_message_from },
  { id: "0012_agent_instance.sql", sql: m0012_agent_instance },
  { id: "0013_instance_session_id.sql", sql: m0013_instance_session_id },
  { id: "0014_drop_agent_runtime_columns.sql", sql: m0014_drop_agent_runtime_columns },
  { id: "0015_add_instance_id_to_session_message.sql", sql: m0015_add_instance_id_to_session_message },
  { id: "0016_jazzy_gamma_corps.sql", sql: m0016_jazzy_gamma_corps },
  { id: "0017_hesitant_marvex.sql", sql: m0017_hesitant_marvex },
  { id: "0018_natural_sinister_six.sql", sql: m0018_natural_sinister_six },
  { id: "0019_rename_grant_source_to_origin.sql", sql: m0019_rename_grant_source_to_origin },
  { id: "0020_add_agent_role.sql", sql: m0020_add_agent_role },
  { id: "0021_acoustic_ozymandias.sql", sql: m0021_acoustic_ozymandias },
  { id: "0022_material_sleepwalker.sql", sql: m0022_material_sleepwalker },
  { id: "0023_flawless_scarlet_witch.sql", sql: m0023_flawless_scarlet_witch },
  { id: "0024_bumpy_sharon_ventura.sql", sql: m0024_bumpy_sharon_ventura },
  { id: "0025_curvy_firestar.sql", sql: m0025_curvy_firestar },
  { id: "0026_keen_ultimo.sql", sql: m0026_keen_ultimo },
  { id: "0027_git_tokens.sql", sql: m0027_git_tokens },
  { id: "0028_wet_sugar_man.sql", sql: m0028_wet_sugar_man },
  { id: "0029_loose_warlock.sql", sql: m0029_loose_warlock },
  { id: "0030_session_asset_audit_split.sql", sql: m0030_session_asset_audit_split },
  { id: "0031_gigantic_nicolaos.sql", sql: m0031_gigantic_nicolaos },
  { id: "0032_lethal_misty_knight.sql", sql: m0032_lethal_misty_knight },
  { id: "0033_old_payback.sql", sql: m0033_old_payback },
  { id: "0034_sleepy_songbird.sql", sql: m0034_sleepy_songbird },
  { id: "0035_violet_giant_man.sql", sql: m0035_violet_giant_man },
  { id: "0036_sharp_the_executioner.sql", sql: m0036_sharp_the_executioner },
  { id: "0037_credential_use_backfill.sql", sql: m0037_credential_use_backfill },
  { id: "0038_chilly_blacklash.sql", sql: m0038_chilly_blacklash },
  { id: "0039_quick_carnage.sql", sql: m0039_quick_carnage },
  { id: "0040_reshape_approval_origin.sql", sql: m0040_reshape_approval_origin },
  { id: "0041_make_approval_timeout_at_nullable.sql", sql: m0041_make_approval_timeout_at_nullable },
  { id: "0042_youthful_mantis.sql", sql: m0042_youthful_mantis },
  { id: "0043_signal_correlation_deployment_fk.sql", sql: m0043_signal_correlation_deployment_fk },
  { id: "0044_model_offering_quirks.sql", sql: m0044_model_offering_quirks },
  { id: "0045_create_workflow_run.sql", sql: m0045_create_workflow_run },
  { id: "0046_approval_signal_correlation_run_fk.sql", sql: m0046_approval_signal_correlation_run_fk },
  { id: "0047_create_workflow_definition.sql", sql: m0047_create_workflow_definition },
  { id: "0048_workflow_definition_origin_agent_id.sql", sql: m0048_workflow_definition_origin_agent_id },
  { id: "0049_curly_omega_flight.sql", sql: m0049_curly_omega_flight },
  { id: "0050_late_crystal.sql", sql: m0050_late_crystal },
  { id: "0051_funny_madelyne_pryor.sql", sql: m0051_funny_madelyne_pryor },
  { id: "0052_drop_inference_turn_instance_fk.sql", sql: m0052_drop_inference_turn_instance_fk },
  { id: "0053_session_mail_session_id_index.sql", sql: m0053_session_mail_session_id_index },
  { id: "0054_rekey_instance_grants_to_workflow_run.sql", sql: m0054_rekey_instance_grants_to_workflow_run },
  { id: "0055_backfill_anchor_workflow_runs.sql", sql: m0055_backfill_anchor_workflow_runs },
  { id: "0056_repoint_deployment_fks_to_anchor_run.sql", sql: m0056_repoint_deployment_fks_to_anchor_run },
  { id: "0057_drop_workflow_deployment_projection.sql", sql: m0057_drop_workflow_deployment_projection },
  { id: "0058_repoint_offering_fk_to_definition.sql", sql: m0058_repoint_offering_fk_to_definition },
  { id: "0059_repoint_transaction_fk_to_run.sql", sql: m0059_repoint_transaction_fk_to_run },
  { id: "0060_drop_session_mail_instance_fk.sql", sql: m0060_drop_session_mail_instance_fk },
  { id: "0061_drop_session_asset_instance_fk.sql", sql: m0061_drop_session_asset_instance_fk },
  { id: "0062_drop_agent_asset_table.sql", sql: m0062_drop_agent_asset_table },
  { id: "0063_repoint_agent_role_fk_to_definition.sql", sql: m0063_repoint_agent_role_fk_to_definition },
  { id: "0064_repoint_agent_session_fk_to_definition.sql", sql: m0064_repoint_agent_session_fk_to_definition },
  { id: "0065_add_workflow_definition_model_requirements.sql", sql: m0065_add_workflow_definition_model_requirements },
  { id: "0066_rekey_agent_definition_principals_to_workflow.sql", sql: m0066_rekey_agent_definition_principals_to_workflow },
  { id: "0067_add_workflow_definition_kind.sql", sql: m0067_add_workflow_definition_kind },
  { id: "0068_drop_agent_tables_and_origin_agent_id.sql", sql: m0068_drop_agent_tables_and_origin_agent_id },
  { id: "0069_drop_workflow_definition_kind.sql", sql: m0069_drop_workflow_definition_kind },
  { id: "0070_flashy_proteus.sql", sql: m0070_flashy_proteus },
  { id: "0072_add_workflow_definition_credential_bindings.sql", sql: m0072_add_workflow_definition_credential_bindings },
  { id: "0073_grant_target_exactly_one_check.sql", sql: m0073_grant_target_exactly_one_check },
  { id: "0074_add_provider_api_base_url.sql", sql: m0074_add_provider_api_base_url },
  { id: "0075_workflow_run_launch_spec.sql", sql: m0075_workflow_run_launch_spec },
  { id: "0076_sidecar_allocation.sql", sql: m0076_sidecar_allocation },
  { id: "0077_workflow_run_dispatch.sql", sql: m0077_workflow_run_dispatch },
  { id: "0078_workflow_run_dispatch_kind.sql", sql: m0078_workflow_run_dispatch_kind },
  { id: "0079_rename_workflow_run_deployment_id_to_anchor_run_id.sql", sql: m0079_rename_workflow_run_deployment_id_to_anchor_run_id },
  { id: "0080_rename_correlation_approval_deployment_id_to_anchor_run_id.sql", sql: m0080_rename_correlation_approval_deployment_id_to_anchor_run_id },
  { id: "0081_workflow_definition_content_hash_and_approved_wire_hash.sql", sql: m0081_workflow_definition_content_hash_and_approved_wire_hash },
  { id: "0082_blue_black_queen.sql", sql: m0082_blue_black_queen },
  { id: "0083_replace_launch_spec_snapshot_with_frozen_bundle.sql", sql: m0083_replace_launch_spec_snapshot_with_frozen_bundle },
  { id: "0084_delete_orphaned_credential_grants.sql", sql: m0084_delete_orphaned_credential_grants },
  { id: "0085_add_approval_run_idx.sql", sql: m0085_add_approval_run_idx },
  { id: "0086_cool_human_cannonball.sql", sql: m0086_cool_human_cannonball },
  { id: "0087_drop_sidecar_placement.sql", sql: m0087_drop_sidecar_placement },
  { id: "0088_thick_sprite.sql", sql: m0088_thick_sprite },
  { id: "0089_tense_selene.sql", sql: m0089_tense_selene },
  { id: "0090_tenant_domain_lower_unique.sql", sql: m0090_tenant_domain_lower_unique },
  { id: "0091_workflow_run_dispatch_sender_address.sql", sql: m0091_workflow_run_dispatch_sender_address },
  { id: "0092_sidecar_destroy_failed.sql", sql: m0092_sidecar_destroy_failed },
];
