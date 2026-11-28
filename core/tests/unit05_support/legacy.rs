use shiguang_core::{
    json::Json,
    story::{Story, StoryComplexity},
};

/// Convert only representable synthetic snapshots for old-writer tests.
pub fn legacy_snapshots(state: &mut Json) {
    let Json::Obj(fields) = state else {
        panic!("state")
    };
    for (key, value) in fields {
        if key == "version" {
            *value = Json::Num(1);
        }
        if !matches!(key.as_str(), "records" | "conflictCopies") {
            continue;
        }
        let Json::Arr(rows) = value else {
            panic!("rows")
        };
        for row in rows {
            let Json::Obj(fields) = row else {
                panic!("row")
            };
            for (slot, snap) in fields {
                if !matches!(slot.as_str(), "formal" | "draft" | "snapshot") || *snap == Json::Null
                {
                    continue;
                }
                let story = Story::from_json(snap.get("story").unwrap()).unwrap();
                assert_eq!(story.complexity(), StoryComplexity::Simple);
                let Json::Obj(fields) = snap else {
                    panic!("snapshot")
                };
                fields.retain(|(k, _)| k != "story");
                let Json::Obj(content) = (*story).to_json() else {
                    unreachable!()
                };
                fields.extend(content);
            }
        }
    }
}
