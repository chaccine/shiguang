//! Synthetic CPU/storage benchmark, not a device or image-decoding claim.
mod unit05_support;
mod unit07_support;
use shiguang_core::{json::Json, SearchFilter, SearchPage, Store, TimelineFilter};
use std::{fs,time::Instant};
use unit07_support::*;
fn timed(name:&str, report:&mut Vec<Json>, f:impl FnOnce()->SearchPage)->SearchPage {
    let start=Instant::now();let page=f();let ms=start.elapsed().as_secs_f64()*1000.;
    assert_eq!(page.page.items.len(),50);assert!(ms<10000.,"{name}: {ms}ms exceeds machine-specific generous debug guard");
    report.push(Json::obj(vec![("name",Json::str(name)),("ms",Json::str(format!("{ms:.3}"))),
        ("returned",Json::Num(page.page.items.len() as i64)),("total",Json::Num(page.page.total as i64))]));page
}
#[test]
fn five_thousand_representative_records_cold_warm_first_and_subsequent_pages() {
    let t=Temp::new("u012-stress");let mut seed=Store::open(&t.0).unwrap();let id=draft(&mut seed,"synthetic seed");
    let original=photo(&mut seed,&id,"synthetic-search-photo");
    let a=seed.create_tag("校园旅行 Travel").unwrap();let b=seed.create_tag("日常 Daily").unwrap();
    let mut rows=synthetic_rows(5000);
    for (i,r) in rows.iter_mut().enumerate() {
        let f=r.formal.as_mut().unwrap();f.title=format!("合成旅程 Synthetic memory {}",i+1);
        f.body="合成日记：今天走过河边，与朋友记录一段普通生活。 English readable paragraph. ".repeat(24)
            + if i%5==0 {" UniqueNeedle 第一次坐火车。"}else{" 普通结尾。"};
        f.location="合成地点 Synthetic station".into();r.tag_ids=vec![if i%2==0 {a.tag_id.clone()}else{b.tag_id.clone()}];
        r.favorite=i%3==0;r.museum_hidden=i%37==0;
        if i%4!=0 {for j in 0..(i%2+1) {let mut p=original.clone();p.photo_use_id=format!("pu-{:06}",20000+i*2+j);
            p.caption=format!("合成照片说明 {j} Sunny trip. ").repeat(4);f.photos.push(p);}
            f.cover_photo_use_id=f.photos.last().map(|p|p.photo_use_id.clone());}
    }
    let state=with_rows(&seed,&rows);let snapshot=state.to_json(seed.seed()).dump();drop(seed);
    fs::write(t.0.join("state.json"),&snapshot).unwrap();
    let filter=SearchFilter{keyword:"uniqueneedle".into(),..Default::default()};let mut timings=vec![];
    let mut opened=None;
    let first=timed("coldOpenAndFirst",&mut timings,||{let s=Store::open(&t.0).unwrap();let p=s.search_page(&filter,None,50,TODAY).unwrap();opened=Some(s);p});
    assert_eq!(first.page.total,1000);let s=opened.unwrap();
    for n in 1..=3 {timed(&format!("warmFirst{n}"),&mut timings,||s.search_page(&filter,None,50,TODAY).unwrap());}
    let mut seen:std::collections::BTreeSet<_>=first.page.items.iter().map(|r|r.record_id.clone()).collect();let mut cursor=first.page.next_cursor;
    for n in 2..=4 {let p=timed(&format!("page{n}"),&mut timings,||s.search_page(&filter,cursor,50,TODAY).unwrap());
        assert_eq!(p.page.total,1000);for r in p.page.items {assert!(seen.insert(r.record_id));}cursor=p.page.next_cursor;}
    assert_eq!(seen.len(),200);
    let combined=SearchFilter {keyword:"uniqueneedle".into(),timeline:TimelineFilter {tag_ids:vec![a.tag_id,b.tag_id],
        from:Some("2000-01-01".into()),to:Some("2029-12-31".into()),favorite_only:true,has_photo:Some(true),..Default::default()}};
    assert_eq!(timed("combinedFirst",&mut timings,||s.search_page(&combined,None,50,TODAY).unwrap()).page.total,250);
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(),snapshot.as_bytes());assert_eq!(fs::read_dir(t.0.join("previews")).unwrap().count(),0);
    let range=|values:Vec<usize>|Json::obj(vec![("min",Json::Num(*values.iter().min().unwrap() as i64)),("max",Json::Num(*values.iter().max().unwrap() as i64))]);
    let report=Json::obj(vec![("records",Json::Num(5000)),("photoUses",Json::Num(rows.iter().map(|r|r.formal.as_ref().unwrap().photos.len() as i64).sum())),
        ("stateBytes",Json::Num(snapshot.len() as i64)),("perCallRegressionBudgetMs",Json::Num(10000)),
        ("fieldUtf8Bytes",Json::obj(vec![("title",range(rows.iter().map(|r|r.formal.as_ref().unwrap().title.len()).collect())),
            ("body",range(rows.iter().map(|r|r.formal.as_ref().unwrap().body.len()).collect())),
            ("location",range(rows.iter().map(|r|r.formal.as_ref().unwrap().location.len()).collect())),
            ("caption",range(rows.iter().flat_map(|r|r.formal.as_ref().unwrap().photos.iter().map(|p|p.caption.len())).collect()))])),
        ("timings",Json::Arr(timings)),("scope",Json::str("Synthetic only; cold=new Store open+first query, OS caches not flushed, no device/IPC/UI PASS"))]);
    println!("{}",report.pretty());if let Ok(path)=std::env::var("SHIGUANG_SEARCH_STRESS_OUT"){fs::write(path,report.pretty()).unwrap();}
}
