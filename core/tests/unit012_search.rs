mod unit05_support;
mod unit07_support;
use shiguang_core::{search::search_page, DraftPatch, Order, PhotoUse, RecordRow, RecordStatus, SearchFilter, SearchPage, Store, TimelineFilter};
use unit07_support::*;

fn filter(keyword: &str) -> SearchFilter { SearchFilter { keyword: keyword.into(), ..Default::default() } }
fn ids(p: &SearchPage) -> Vec<String> { p.page.items.iter().map(|r| r.record_id.clone()).collect() }
fn rid(n: usize) -> String { format!("rec-{n:06}") }
fn photos(r: &mut RecordRow) {
    let f = r.formal.as_mut().unwrap();
    f.photos.push(PhotoUse { photo_use_id: format!("pu-{}",r.record_id), asset_id: "ast-shared".into(), caption: "neutral".into(),
        sha256: "0".repeat(64), bytes: 1, media_type: "image/png".into() });
    f.cover_photo_use_id = Some(f.photos[0].photo_use_id.clone());
}
#[test]
fn each_field_literal_unicode_and_unique_record_matching() {
    let t=Temp::new("u012-fields"); let mut s=Store::open(&t.0).unwrap(); let tag=s.create_tag("Needle校园").unwrap();
    let mut rows=synthetic_rows(8);
    for r in &mut rows { let f=r.formal.as_mut().unwrap(); f.title.clear(); f.body="neutral".into(); }
    rows[0].formal.as_mut().unwrap().title="Needle标题".into();
    rows[1].formal.as_mut().unwrap().body="正文Needle".into();
    photos(&mut rows[2]); rows[2].formal.as_mut().unwrap().body.clear(); rows[2].formal.as_mut().unwrap().photos[0].caption="Needle说明".into();
    rows[3].formal.as_mut().unwrap().location="Needle车站".into(); rows[4].tag_ids=vec![tag.tag_id.clone()];
    rows[5].formal.as_mut().unwrap().body="Needle".into(); rows[5].formal.as_mut().unwrap().title="Needle".into(); rows[5].tag_ids=vec![tag.tag_id];
    rows[6].formal.as_mut().unwrap().title="Nee".into(); rows[6].formal.as_mut().unwrap().body="dle".into();
    photos(&mut rows[7]); rows[7].formal.as_mut().unwrap().photos[0].asset_id="Needle-image-name".into();
    let state=with_rows(&s,&rows);
    let run=|q:&str| search_page(&state,&filter(q),None,50,TODAY).unwrap();
    let mut got=ids(&run(" \u{feff}nEeDlE　\n")); got.sort(); assert_eq!(got,(1..=6).map(rid).collect::<Vec<_>>());
    for (q,n) in [("标题",1),("正文nE",2),("说明",3),("车站",4)] { assert_eq!(ids(&run(q)),vec![rid(n)]); }
    assert_eq!(run("校园").page.total,2); assert_eq!(run("Needle-image-name").page.total,0); assert_eq!(run("").page.total,8);
    rows[0].formal.as_mut().unwrap().body="第一次坐火车 café e\u{301} 🚂👩‍👩‍👧‍👦 [a-z]+ .* ^$ \\d (x|y) <script>alert(\"x\")</script> %_".into();
    let state=with_rows(&s,&rows);
    for q in ["次坐火","café","e\u{301}","🚂","👩‍👩‍👧‍👦","[a-z]+",".*","^$","\\d","(x|y)","<script>alert(\"x\")</script>","%_"] {
        assert_eq!(search_page(&state,&filter(q),None,50,TODAY).unwrap().page.total,1,"{q}");
    }
    for q in ["第一次 火车","[A-Z]*","<img onerror=alert(1)>","CAFÉ","é 🚂"] {
        assert_eq!(search_page(&state,&filter(q),None,50,TODAY).unwrap().page.total,0,"{q}");
    }
}
#[test]
fn all_192_filter_combinations_and_reset() {
    let t=Temp::new("u012-combinations"); let mut s=Store::open(&t.0).unwrap();
    let a=s.create_tag("Alpha").unwrap().tag_id; let b=s.create_tag("Beta").unwrap().tag_id;
    let mut rows=synthetic_rows(32);
    for (i,r) in rows.iter_mut().enumerate() {
        let f=r.formal.as_mut().unwrap(); f.body=if i&1!=0 {"Needle"}else{"neutral"}.into();
        f.event_date=if i&4!=0 {"2024-02-29"}else{"2024-03-01"}.into();
        r.tag_ids=if i&2!=0 {vec![a.clone(),b.clone()]}else if i&4!=0 {vec![b.clone()]}else{vec![]};
        r.favorite=i&8!=0; if i&16!=0 {photos(r);}
    }
    let state=with_rows(&s,&rows); let mut count=0;
    for keyword in ["","needle"] { for tag_ids in [vec![],vec![a.clone()],vec![a.clone(),b.clone()],vec!["missing".into()]] {
        for range in [false,true] {for favorite in [false,true] {for has_photo in [None,Some(true),Some(false)] {for order in [Order::Asc,Order::Desc] {
            let f=SearchFilter { keyword:keyword.into(),timeline:TimelineFilter {tag_ids:tag_ids.clone(),favorite_only:favorite,has_photo,order,
                from:range.then(||"2024-02-29".into()),to:range.then(||"2024-02-29".into())} };
            let expected:Vec<_>=rows.iter().enumerate().filter(|(i,r)| (keyword.is_empty() || i&1!=0)
                && (tag_ids.is_empty() || tag_ids.iter().any(|id|r.tag_ids.contains(id)))
                && (!range || i&4!=0) && (!favorite || i&8!=0) && has_photo.is_none_or(|v|v==(i&16!=0))).map(|(_,r)|r.record_id.clone()).collect();
            let page=search_page(&state,&f,None,500,TODAY).unwrap(); let mut got=ids(&page);got.sort();
            assert_eq!(got,expected,"{f:?}");assert_eq!(page.page.total,expected.len());count+=1;
        }}}}
    }}
    assert_eq!(count,192);
    let f=SearchFilter {keyword:" 　 ".into(), timeline:TimelineFilter {from:Some("".into()),to:Some("".into()),..Default::default()}};
    assert_eq!(search_page(&state,&f,None,500,TODAY).unwrap().page.total,32);
}
#[test]
fn inclusive_leap_ranges_validation_and_limits() {
    let t=Temp::new("u012-date");let s=Store::open(&t.0).unwrap();let mut rows=synthetic_rows(4);
    for (r,date) in rows.iter_mut().zip(["2000-02-29","2024-02-29","2024-03-01","2100-03-01"]) {r.formal.as_mut().unwrap().event_date=date.into();}
    let state=with_rows(&s,&rows);
    for (from,to,count) in [(Some("2024-02-29"),Some("2024-03-01"),2),(None,Some("2000-02-29"),1),(Some("2100-03-01"),None,1)] {
        let f=SearchFilter {timeline:TimelineFilter {from:from.map(str::to_owned),to:to.map(str::to_owned),..Default::default()},..Default::default()};
        assert_eq!(search_page(&state,&f,None,50,TODAY).unwrap().page.total,count);
    }
    for date in ["1900-02-29","2100-02-29","2023-02-29","2024-2-29","2024-04-31","2024-00-01","2024-01-00","x"] {
        for from in [true,false] {
            let mut f=filter("");if from {f.timeline.from=Some(date.into());}else{f.timeline.to=Some(date.into());}
            assert_eq!(search_page(&state,&f,None,50,TODAY).unwrap_err().code,"INVALID_EVENT_DATE");
        }
    }
    let mut f=filter("");f.timeline.from=Some("2024-03-01".into());f.timeline.to=Some("2024-02-29".into());
    assert_eq!(search_page(&state,&f,None,50,TODAY).unwrap_err().code,"INVALID_EVENT_DATE");
    for limit in [0,501,usize::MAX] {assert_eq!(search_page(&state,&filter(""),None,limit,TODAY).unwrap_err().code,"INVALID_LIMIT");}
    assert_eq!(search_page(&state,&filter(""),None,50,"2100-02-29").unwrap_err().code,"INVALID_EVENT_DATE");
}
#[test]
fn same_day_full_m02_ties_both_directions_and_cursor_mismatch() {
    let t=Temp::new("u012-pages");let s=Store::open(&t.0).unwrap();let mut rows=synthetic_rows(103);
    for (i,r) in rows.iter_mut().enumerate() {
        r.created_at=if i%4==0 {"early"}else{"same"}.into();let f=r.formal.as_mut().unwrap();f.event_date="2024-02-29".into();
        f.event_time=if i%3==0 {None}else{Some(if i%2==0 {"10:00"}else{"09:00"}.into())};
    }
    let state=with_rows(&s,&rows);
    for order in [Order::Asc,Order::Desc] {
        let f=SearchFilter {timeline:TimelineFilter {order,..Default::default()},..Default::default()};
        let expected=shiguang_core::query::timeline_page(&state,&f.timeline,None,500,TODAY).unwrap();
        let mut got=Vec::new();let mut cursor=None;
        loop {let p=search_page(&state,&f,cursor,7,TODAY).unwrap();assert_eq!(p.page.total,103);got.extend(ids(&p));
            cursor=p.page.next_cursor;assert!(got.len()<=103);if cursor.is_none(){break;}}
        assert_eq!(got,expected.items.iter().map(|r|r.record_id.clone()).collect::<Vec<_>>());
    }
    let first=search_page(&state,&filter(""),None,1,TODAY).unwrap();
    for dimension in 0..8 {
        let mut f=filter("");match dimension {0=>f.keyword="合成".into(),1=>f.timeline.tag_ids=vec!["x".into()],
            2=>f.timeline.from=Some("2000-01-01".into()),3=>f.timeline.to=Some("2030-01-01".into()),4=>f.timeline.favorite_only=true,
            5=>f.timeline.has_photo=Some(true),6=>f.timeline.has_photo=Some(false),_=>f.timeline.order=Order::Asc}
        assert_eq!(search_page(&state,&f,first.page.next_cursor.clone(),1,TODAY).unwrap_err().code,"SEARCH_CURSOR_MISMATCH");
    }
    assert_eq!(search_page(&state,&filter(""),first.page.next_cursor.clone(),1,"2026-11-11").unwrap_err().code,"SEARCH_CURSOR_MISMATCH");
    let nested="[".repeat(1000)+"0"+&"]".repeat(1000);
    let nested_inner=shiguang_core::json::Json::Arr(vec![shiguang_core::json::Json::str("sg12"),shiguang_core::json::Json::str(&first.query_key),
        shiguang_core::json::Json::str(&first.source_generation),shiguang_core::json::Json::str(shiguang_core::sha256::hex(nested.as_bytes()))]).dump();
    for cursor in [nested,nested_inner,"".into(),"oops".into(),"[]".into(),"\"x\"".into(),"x".repeat(32769)] {
        assert_eq!(search_page(&state,&filter(""),Some(cursor),1,TODAY).unwrap_err().code,"INVALID_CURSOR");
    }
    let first=search_page(&state,&filter("  合成  "),None,1,TODAY).unwrap();
    assert_eq!(search_page(&state,&filter("合成"),first.page.next_cursor,2,TODAY).unwrap().page.items.len(),2);
}
#[test]
fn source_generation_covers_equal_revision_changes_but_ignores_drafts_and_hidden() {
    let t=Temp::new("u012-source");let s=Store::open(&t.0).unwrap();let mut rows=synthetic_rows(4);photos(&mut rows[0]);
    let base=with_rows(&s,&rows);let first=search_page(&base,&filter(""),None,1,TODAY).unwrap();
    for field in 0..9 {
        let mut changed=rows.clone();let r=&mut changed[0];let f=r.formal.as_mut().unwrap();
        match field {0=>f.title.push('x'),1=>f.body.push('x'),2=>f.location.push('x'),3=>f.event_date="2024-02-29".into(),
            4=>f.photos[0].caption.push('x'),5=>r.favorite=true,6=>f.event_time=Some("23:59".into()),
            7=>{r.status=RecordStatus::Trashed;r.trashed_at=Some("synthetic".into());},_=>{changed.pop();}}
        let state=with_rows(&s,&changed);
        assert_eq!(search_page(&state,&filter(""),first.page.next_cursor.clone(),1,TODAY).unwrap_err().code,"SEARCH_CURSOR_STALE");
    }
    rows[0].draft=rows[0].formal.clone();rows[0].draft.as_mut().unwrap().body="draft secret".into();rows[0].museum_hidden=true;
    let state=with_rows(&s,&rows);assert_eq!(search_page(&state,&filter(""),first.page.next_cursor,1,TODAY).unwrap().page.items.len(),1);
    assert_eq!(search_page(&state,&filter("draft secret"),None,50,TODAY).unwrap().page.total,0);
}
#[test]
fn formal_only_and_metadata_transactions_commit_trash_restore_reopen() {
    let t=Temp::new("u012-mutate");let mut s=Store::open(&t.0).unwrap();let a=formal(&mut s);formal(&mut s);draft(&mut s,"private draft");
    let old=s.create_tag("OldName").unwrap();let target=s.create_tag("TargetName").unwrap();
    s.set_record_tags(&a,std::slice::from_ref(&old.tag_id),None).unwrap();s.set_museum_hidden(&a,true).unwrap();
    s.save_draft_patch(&a,&DraftPatch {body:Some("Uncommitted".into()),event_date:Some("2030-01-01".into()),location:Some("Draft place".into()),..Default::default()}).unwrap();
    let first=s.search_page(&filter(""),None,1,TODAY).unwrap();assert_eq!(first.page.total,2);
    assert_eq!(s.search_page(&filter("private draft"),None,50,TODAY).unwrap().page.total,0);
    s.set_favorite(&a,true,None).unwrap();assert_eq!(s.search_page(&filter("Uncommitted"),None,50,TODAY).unwrap().page.total,0);
    let favorites=SearchFilter {timeline:TimelineFilter {favorite_only:true,..Default::default()},..Default::default()};
    assert_eq!(ids(&s.search_page(&favorites,None,50,TODAY).unwrap()),vec![a.clone()]);
    assert_eq!(s.search_page(&filter(""),first.page.next_cursor,1,TODAY).unwrap_err().code,"SEARCH_CURSOR_STALE");
    s.rename_tag(&old.tag_id,"Renamed").unwrap();assert_eq!(s.search_page(&filter("OldName"),None,50,TODAY).unwrap().page.total,0);
    assert_eq!(ids(&s.search_page(&filter("renamed"),None,50,TODAY).unwrap()),vec![a.clone()]);
    s.merge_tags(&old.tag_id,&target.tag_id).unwrap();assert_eq!(s.search_page(&filter("Renamed"),None,50,TODAY).unwrap().page.total,0);
    assert_eq!(s.search_page(&filter("TargetName"),None,50,TODAY).unwrap().page.total,1);
    s.commit(&a,1).unwrap();assert!(s.row(&a).unwrap().favorite);assert_eq!(s.search_page(&filter("Uncommitted"),None,50,TODAY).unwrap().page.total,1);
    s.delete_tag(&target.tag_id).unwrap();assert_eq!(s.search_page(&filter("TargetName"),None,50,TODAY).unwrap().page.total,0);
    s.trash_record(&a).unwrap();assert_eq!(s.search_page(&filter("Uncommitted"),None,50,TODAY).unwrap().page.total,0);
    s.restore_record(&a).unwrap();drop(s);let s=Store::open(&t.0).unwrap();
    assert_eq!(s.search_page(&filter("Uncommitted"),None,50,TODAY).unwrap().page.total,1);
}
#[test]
fn backup_overwrite_merge_reimport_and_deletion_use_current_authority() {
    let t=Temp::new("u012-backup");let mut src=Store::open(t.0.join("src")).unwrap();let a=formal(&mut src);let b=formal(&mut src);
    photo(&mut src,&a,"synthetic-search");src.commit(&a,1).unwrap();
    let tag=src.create_tag("BackupTag").unwrap();src.set_record_tags(&a,std::slice::from_ref(&tag.tag_id),None).unwrap();src.set_favorite(&a,true,None).unwrap();
    src.save_draft(&a,None,Some("backup draft secret"),None,None).unwrap();
    let file=t.0.join("original.sgbak");src.export_backup(&file,"0.1.12").unwrap();
    let mut dst=Store::open_exclusive(t.0.join("dst")).unwrap();dst.restore_backup_overwrite(&file).unwrap();
    assert_eq!(dst.search_page(&filter("BackupTag"),None,50,TODAY).unwrap().page.total,1);
    assert_eq!(dst.search_page(&filter("backup draft secret"),None,50,TODAY).unwrap().page.total,0);
    let first=dst.search_page(&filter(""),None,1,TODAY).unwrap();
    src.rename_tag(&tag.tag_id,"NewBackupTag").unwrap();let added=src.create_tag("ImportedOnly").unwrap();src.set_record_tags(&b,&[added.tag_id],None).unwrap();
    let newer=t.0.join("newer.sgbak");src.export_backup(&newer,"0.1.12").unwrap();dst.merge_backup(&newer).unwrap();
    assert_eq!(dst.search_page(&filter(""),first.page.next_cursor,1,TODAY).unwrap_err().code,"SEARCH_CURSOR_STALE");
    assert_eq!(dst.search_page(&filter("ImportedOnly"),None,50,TODAY).unwrap().page.total,1);
    assert_eq!(dst.search_page(&filter("NewBackupTag"),None,50,TODAY).unwrap().page.total,0);
    dst.merge_backup(&newer).unwrap();assert_eq!(dst.search_page(&filter(""),None,50,TODAY).unwrap().page.total,2);
    dst.trash_record(&a).unwrap();dst.merge_backup(&file).unwrap();assert_eq!(ids(&dst.search_page(&filter(""),None,50,TODAY).unwrap()),vec![b.clone()]);
    dst.purge_record(&a).unwrap();dst.merge_backup(&file).unwrap();assert_eq!(ids(&dst.search_page(&filter(""),None,50,TODAY).unwrap()),vec![b]);
    dst.restore_backup_overwrite(&file).unwrap();assert_eq!(dst.search_page(&filter("BackupTag"),None,50,TODAY).unwrap().page.total,1);
}
#[cfg(feature="fault-injection")]
#[test]
fn failed_metadata_transaction_preserves_search_generation_and_results() {
    use shiguang_core::fault::{self,FaultPoint};
    for point in [FaultPoint::TempWrite,FaultPoint::Replace] {
        let t=Temp::new("u012-fault");let mut s=Store::open(&t.0).unwrap();let id=formal(&mut s);formal(&mut s);
        let a=s.create_tag("Before").unwrap();let b=s.create_tag("Target").unwrap();s.set_record_tags(&id,std::slice::from_ref(&a.tag_id),None).unwrap();
        for op in 0..4 {
            let before=s.search_page(&filter(""),None,1,TODAY).unwrap();fault::set(point);
            let result=match op {0=>s.set_favorite(&id,true,None).map(|_|()),1=>s.rename_tag(&a.tag_id,"After").map(|_|()),
                2=>s.merge_tags(&a.tag_id,&b.tag_id).map(|_|()),_=>s.delete_tag(&a.tag_id).map(|_|())};
            assert!(result.is_err());fault::clear();
            assert_eq!(s.search_page(&filter(""),before.page.next_cursor,1,TODAY).unwrap().page.items.len(),1);
            assert_eq!(s.search_page(&filter("Before"),None,50,TODAY).unwrap().page.total,1);
        }
    }
}

#[test]
fn rust_ts_normalized_query_and_formal_source_fingerprint_golden_contract() {
    let t=Temp::new("u012-golden");let s=Store::open(&t.0).unwrap();let state=with_rows(&s,&synthetic_rows(1));
    let page=search_page(&state,&filter(" 合成 "),None,50,"2026-11-12").unwrap();
    assert_eq!(page.query_key,"3017d2cf42a5be4994d4780d4590e988557e5f3347e7814d6e40aaa91e8cada4");
    assert_eq!(page.source_generation,"6ef6687ef36739de6fb8cc7a21d8408cbdd76db060acc7810f126e866182766c");
}
#[test]
fn shared_asset_caption_changes_publish_only_on_commit_and_preserve_favorite() {
    let t=Temp::new("u012-caption");let mut s=Store::open(&t.0).unwrap();let a=formal(&mut s);let b=formal(&mut s);
    let pa=photo(&mut s,&a,"shared-original");s.commit(&a,1).unwrap();let pb=photo(&mut s,&b,"shared-original");s.commit(&b,1).unwrap();
    assert_eq!(pa.asset_id,pb.asset_id);let first=s.search_page(&filter(""),None,1,TODAY).unwrap();
    s.set_draft_photo_caption(&a,&pa.photo_use_id,"private caption").unwrap();
    assert_eq!(s.search_page(&filter("private caption"),None,50,TODAY).unwrap().page.total,0);
    assert_eq!(s.search_page(&filter(""),first.page.next_cursor,1,TODAY).unwrap().page.items.len(),1);
    s.set_favorite(&a,true,None).unwrap();s.commit(&a,2).unwrap();assert!(s.row(&a).unwrap().favorite);
    assert_eq!(ids(&s.search_page(&filter("private caption"),None,50,TODAY).unwrap()),vec![a.clone()]);
    assert_eq!(ids(&s.search_page(&filter("合成说明"),None,50,TODAY).unwrap()),vec![b]);
    s.set_favorite(&a,false,None).unwrap();assert_eq!(s.search_page(&filter("private caption"),None,50,TODAY).unwrap().page.total,1);
}
