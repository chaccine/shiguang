//! T-4.1 exercises the domain in memory with synthetic content.
use shiguang_core::{
    json::{self, Json},
    sha256,
    story::{Story, StoryBlock, StoryComplexity, TextRun},
    Mood, PhotoUse, Snapshot,
};
use StoryBlock::{Divider, Paragraph, Photo, Quote, SmallHeading};
use StoryComplexity::{Complex, Simple};

fn photo(id: &str, original: &str, caption: &str) -> PhotoUse {
    let sha256 = sha256::hex_digest(original.as_bytes());
    PhotoUse {
        photo_use_id: id.into(),
        asset_id: format!("ast-{}", &sha256[..16]),
        caption: caption.into(),
        sha256,
        bytes: original.len() as u64,
        media_type: "image/png".into(),
    }
}

fn photo_block(photo: &PhotoUse) -> Json {
    Json::obj(vec![
        ("kind", Json::str("photo")),
        ("photoUse", photo.to_json()),
    ])
}

fn document(blocks: Vec<Json>, cover: Option<&str>) -> Json {
    Json::obj(vec![
        ("blocks", Json::Arr(blocks)),
        (
            "coverPhotoUseId",
            cover.map(Json::str).unwrap_or(Json::Null),
        ),
    ])
}

fn legacy_round_trip(source: &Snapshot) -> Story {
    let before = source.to_json().dump();
    let story = Story::from_legacy(source).unwrap();
    let rebuilt = Snapshot {
        body: story.plain_text(),
        photos: story.photos().cloned().collect(),
        cover_photo_use_id: story.cover_photo_use_id().map(str::to_owned),
        ..source.clone()
    };
    assert_eq!(rebuilt.to_json().dump(), before);
    assert_eq!(source.to_json().dump(), before);
    story
}

#[test]
fn legacy_content_matches_the_v5_writer_including_repeated_uses_and_non_first_cover() {
    let a = photo("pu-000009", "shared original", " 春\n秋 ");
    let b = photo(
        "pu-000002",
        "shared original",
        "<script>合成</script>\r\n🌱",
    );
    let body = " \t\r\n**字** <b>字</b> e\u{301}\n\n末尾 \n";
    let source = Snapshot {
        title: "旧记录".into(),
        event_date: "2026-11-09".into(),
        event_time: Some("08:15".into()),
        location: "合成地点".into(),
        mood: Some(Mood::Calm),
        body: body.into(),
        cover_photo_use_id: Some(b.photo_use_id.clone()),
        photos: vec![a.clone(), b.clone()],
    };
    let source = Snapshot::from_json(&source.to_json()).unwrap();
    let story = legacy_round_trip(&source);
    assert_eq!(story.cover_photo_use_id(), Some("pu-000002"));
    assert_eq!(
        story.blocks(),
        &[Paragraph(vec![TextRun::plain(body)]), Photo(a), Photo(b)]
    );
    assert_eq!(story.complexity(), Simple);
}

#[test]
fn legacy_empty_whitespace_and_line_endings_preserve_literal_paragraph_boundaries() {
    for body in ["", " ", "\t\u{3000}\r\n", "\n", "\n\n", "\rfirst\r\n\n末\n"] {
        let source = Snapshot {
            body: body.into(),
            ..Snapshot::default()
        };
        let story = legacy_round_trip(&source);
        if body.is_empty() {
            assert!(story.blocks().is_empty());
        } else {
            assert_eq!(story.blocks(), &[Paragraph(vec![TextRun::plain(body)])]);
        }
        assert_eq!(story.plain_text(), body);
        assert_eq!(story.has_content(), !body.trim().is_empty());
        assert_eq!(story.complexity(), Simple);
    }
    let p = photo("pu-000003", "photo only", "");
    let story = legacy_round_trip(&Snapshot {
        cover_photo_use_id: Some(p.photo_use_id.clone()),
        photos: vec![p.clone()],
        ..Snapshot::default()
    });
    assert_eq!(story.blocks(), &[Photo(p)]);
    assert!(story.has_content());
    assert_eq!(story.plain_text(), "");
}

#[test]
fn decoded_interleaved_story_preserves_all_marks_and_projects_literal_text_and_photos() {
    let a = photo("pu-000004", "one original", "封面以外\n的说明");
    let b = photo("pu-000001", "one original", "**独立说明**");
    let heading = r#"{"kind":"smallHeading","runs":[{"text":"序","bold":false,"italic":false}]}"#;
    let paragraph = r#"{"kind":"paragraph","runs":[
        {"text":"<script>","bold":true,"italic":false},
        {"text":"🌱&","bold":false,"italic":true},
        {"text":"e\u0301","bold":true,"italic":true},
        {"text":"</script> **字**","bold":false,"italic":false}
    ]}"#;
    let quote = r#"{"kind":"quote","runs":[{"text":" 引\n用 ","bold":false,"italic":false}]}"#;
    let raw = document(
        vec![
            json::parse(heading).unwrap(),
            photo_block(&a),
            json::parse(paragraph).unwrap(),
            json::parse(r#"{"kind":"divider"}"#).unwrap(),
            photo_block(&b),
            json::parse(quote).unwrap(),
        ],
        Some(&b.photo_use_id),
    );
    let story = Story::from_json(&raw).unwrap();
    assert_eq!(
        story.blocks(),
        &[
            SmallHeading(vec![TextRun::plain("序")]),
            Photo(a.clone()),
            Paragraph(vec![
                TextRun {
                    text: "<script>".into(),
                    bold: true,
                    italic: false
                },
                TextRun {
                    text: "🌱&".into(),
                    bold: false,
                    italic: true
                },
                TextRun {
                    text: "e\u{301}".into(),
                    bold: true,
                    italic: true
                },
                TextRun::plain("</script> **字**"),
            ]),
            Divider,
            Photo(b.clone()),
            Quote(vec![TextRun::plain(" 引\n用 ")]),
        ]
    );
    assert_eq!(
        story.plain_text(),
        "序\n<script>🌱&e\u{301}</script> **字**\n 引\n用 "
    );
    assert_eq!(story.photos().collect::<Vec<_>>(), [&a, &b]);
    assert_eq!(story.cover_photo_use_id(), Some(b.photo_use_id.as_str()));
    assert_eq!(story.complexity(), Complex);
}

#[test]
fn r02_uses_current_blocks_and_marks_even_when_plain_text_is_identical() {
    let p = Photo(photo("pu-000001", "synthetic", "caption"));
    let paragraph = Paragraph(vec![TextRun::plain("one"), TextRun::plain("\ntwo")]);
    let cases = [
        (vec![], Simple),
        (vec![paragraph.clone()], Simple),
        (vec![p.clone()], Simple),
        (vec![paragraph.clone(), p.clone()], Simple),
        (vec![p.clone(), Paragraph(vec![])], Complex),
        (vec![paragraph.clone(), p, paragraph.clone()], Complex),
        (vec![Paragraph(vec![]), Paragraph(vec![])], Complex),
        (vec![SmallHeading(vec![])], Complex),
        (vec![Quote(vec![])], Complex),
        (vec![Divider], Complex),
    ];
    for (blocks, expected) in cases {
        let cover = blocks
            .iter()
            .any(|block| matches!(block, Photo(_)))
            .then(|| "pu-000001".into());
        assert_eq!(Story::new(blocks, cover).unwrap().complexity(), expected);
    }
    for (bold, italic) in [(true, false), (false, true), (true, true)] {
        let block = Paragraph(vec![
            TextRun::plain("a"),
            TextRun {
                text: "b".into(),
                bold,
                italic,
            },
        ]);
        assert_eq!(Story::new(vec![block], None).unwrap().complexity(), Complex);
    }
    let split = Story::new(
        vec![
            Paragraph(vec![TextRun::plain("one")]),
            Paragraph(vec![TextRun::plain("two")]),
        ],
        None,
    )
    .unwrap();
    let joined = Story::new(vec![paragraph], None).unwrap();
    assert_eq!(split.plain_text(), joined.plain_text());
    assert_eq!((split.complexity(), joined.complexity()), (Complex, Simple));
}

#[test]
fn formal_content_requires_text_or_a_photo_and_empty_text_blocks_still_project_newlines() {
    let empty = Story::new(
        vec![
            Paragraph(vec![]),
            Divider,
            SmallHeading(vec![TextRun::plain(" \t")]),
            Quote(vec![]),
        ],
        None,
    )
    .unwrap();
    assert_eq!(empty.plain_text(), "\n \t\n");
    assert!(!empty.has_content());
    assert!(!Story::new(vec![Divider], None).unwrap().has_content());
    for block in [
        SmallHeading(vec![TextRun::plain("题")]),
        Quote(vec![TextRun::plain("引")]),
    ] {
        assert!(Story::new(vec![block], None).unwrap().has_content());
    }
}

#[test]
fn decoder_rejects_unknown_kinds_marks_and_malformed_payloads() {
    for block in [
        "null",
        r#"{}"#,
        r#"{"kind":"video"}"#,
        r#"{"kind":"caption","text":"alone"}"#,
        r#"{"kind":"photo","photoUse":{"caption":"alone"}}"#,
        r#"{"kind":"divider","runs":[]}"#,
        r#"{"kind":"smallHeading","runs":"literal"}"#,
        r#"{"kind":"quote","runs":[null]}"#,
        r#"{"kind":"paragraph","runs":[{"text":1,"bold":true,"italic":false}]}"#,
        r#"{"kind":"paragraph","runs":[{"text":"x","italic":false}]}"#,
        r#"{"kind":"paragraph","runs":[{"text":"x","bold":"false","italic":false}]}"#,
        r#"{"kind":"paragraph","runs":[{"text":"x","bold":false,"italic":false,"underline":true}]}"#,
    ] {
        assert!(
            Story::from_json(&document(vec![json::parse(block).unwrap()], None)).is_err(),
            "{block}"
        );
    }
    for raw in [
        r#"{"blocks":[]}"#,
        r#"{"blocks":{},"coverPhotoUseId":null}"#,
        r#"{"blocks":[],"coverPhotoUseId":1}"#,
        r#"{"blocks":[],"coverPhotoUseId":null,"mode":"simple"}"#,
    ] {
        assert!(
            Story::from_json(&json::parse(raw).unwrap()).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn bad_photo_identities_and_cover_references_fail_at_each_entry_point() {
    let a = photo("pu-000002", "first", "old caption");
    let other = photo("pu-000002", "different", "same ID");
    for (photos, cover) in [
        (vec![], Some("pu-000002")),
        (vec![a.clone()], None),
        (vec![a.clone()], Some(a.asset_id.as_str())),
        (vec![a.clone(), a.clone()], Some("pu-000002")),
        (vec![a.clone(), other], Some("pu-000002")),
        (
            vec![PhotoUse {
                photo_use_id: " ".into(),
                ..a.clone()
            }],
            Some(" "),
        ),
        (
            vec![PhotoUse {
                asset_id: "".into(),
                ..a.clone()
            }],
            Some("pu-000002"),
        ),
        (
            vec![PhotoUse {
                sha256: "bad".into(),
                ..a.clone()
            }],
            Some("pu-000002"),
        ),
    ] {
        let raw = document(photos.iter().map(photo_block).collect(), cover);
        let snapshot = Snapshot {
            photos,
            cover_photo_use_id: cover.map(str::to_owned),
            ..Snapshot::default()
        };
        assert!(Story::from_json(&raw).is_err());
        assert!(Story::from_legacy(&snapshot).is_err());
        assert!(Story::new(
            snapshot.photos.into_iter().map(Photo).collect(),
            snapshot.cover_photo_use_id
        )
        .is_err());
    }
}

#[test]
fn malformed_photo_metadata_cannot_be_silently_dropped() {
    let p = photo("pu-000002", "original", "caption");
    for (field, bad) in [
        ("bytes", Json::Num(-1)),
        ("caption", Json::Bool(true)),
        ("unknown", Json::Null),
    ] {
        let Json::Obj(mut fields) = p.to_json() else {
            unreachable!()
        };
        fields.retain(|(key, _)| key != field);
        fields.push((field.into(), bad));
        let block = Json::obj(vec![
            ("kind", Json::str("photo")),
            ("photoUse", Json::Obj(fields)),
        ]);
        assert!(
            Story::from_json(&document(vec![block], Some(&p.photo_use_id))).is_err(),
            "{field}"
        );
    }
}

#[test]
fn formal_and_draft_can_describe_the_same_occurrence_with_different_originals() {
    let original = photo("pu-000001", "old original", "同一处说明");
    let changed = photo("pu-000001", "new original", "同一处说明");
    let cover = Some(original.photo_use_id.clone());
    let formal = Story::new(vec![Photo(original.clone())], cover.clone()).unwrap();
    let draft = Story::new(vec![Photo(changed.clone())], cover).unwrap();
    assert_ne!(formal, draft);
    assert_eq!(formal.cover_photo_use_id(), draft.cover_photo_use_id());
    assert_eq!(formal.photos().next(), Some(&original));
    assert_eq!(draft.photos().next(), Some(&changed));
}

#[test]
fn shared_editor_fixture_round_trips_v5_and_projects_ordered_runs_and_captions() {
    let cases = json::parse(include_str!("fixtures/story-parity.json")).unwrap();
    let legacy = Snapshot::from_json(cases.get("legacy").unwrap()).unwrap();
    let converted = legacy_round_trip(&legacy);
    assert_eq!(converted.complexity(), Simple);
    assert_eq!(converted.cover_photo_use_id(), Some("pu-000002"));
    for body in cases.get("legacyBodies").unwrap().as_arr().unwrap() {
        let body = body.as_str().unwrap();
        let story = legacy_round_trip(&Snapshot {
            body: body.into(),
            ..Default::default()
        });
        assert_eq!(story.blocks().len(), usize::from(!body.is_empty()));
    }
    let mixed = Story::from_json(cases.get("mixed").unwrap()).unwrap();
    assert_eq!(mixed.complexity(), Complex);
    assert_eq!(
        mixed.plain_text(),
        cases.get("mixedText").unwrap().as_str().unwrap()
    );
    let captions: Vec<_> = mixed.photos().map(|p| Json::str(&p.caption)).collect();
    assert_eq!(Json::Arr(captions), *cases.get("mixedCaptions").unwrap());
}
