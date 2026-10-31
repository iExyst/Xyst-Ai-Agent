fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_last_session",
            "set_last_session",
            "list_projects",
            "choose_project_folder",
            "create_project",
            "switch_project",
            "remove_recent_project",
        ]));
    tauri_build::try_build(attributes).expect("failed to build Tauri application metadata");
}
