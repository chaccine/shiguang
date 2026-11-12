//! M04 queries use synthetic formal records; no private data or media decoding.
mod unit05_support;
mod unit07_support;
use shiguang_core::{museum::*, query, Order, PhotoUse, RecordRow, RecordStatus, Snapshot, Store};
use std::collections::BTreeSet;
use unit07_support::*;

const DAY: &str = "2026-11-12";
fn ids(items: &[shiguang_core::TimelineItem]) -> Vec<String> { items.iter().map(|i| i.record_id.clone()).collect() }
fn reunion_ids(p: &ReunionPage) -> Vec<String> { p.groups.iter().flat_map(|g| ids(&g.items)).collect() }
fn dated(dates: &[&str]) -> Vec<RecordRow> {
    let mut r=synthetic_rows(dates.len());
    for (r,date) in r.iter_mut().zip(dates) { r.formal.as_mut().unwrap().event_date=(*date).into(); }
    r
}
fn photos(row: &mut RecordRow, n: usize, start: usize) {
    let f=row.formal.as_mut().unwrap();
    f.photos=(0..n).map(|i| PhotoUse {photo_use_id:format!("pu-{:06}",start+i),asset_id:"ast-shared".into(),
        caption:format!("{} 使用位 {i}\n<&>",row.record_id),sha256:"0".repeat(64),bytes:1,media_type:"image/png".into()}).collect();
    f.cover_photo_use_id=f.photos.last().map(|p| p.photo_use_id.clone());
}

#[test]
fn reunion_exact_event_date_prior_years_only_and_m03_shares_eligibility() {
    let t=Temp::new("u011-reunion");let s=Store::open(&t.0).unwrap();
    let mut r=dated(&["2025-11-12","2024-11-12","2026-11-12","2027-11-12","2025-11-11","2025-11-13","2020-11-12","2020-11-12","2021-11-12"]);
    r[0].created_at="2026-01-01T00:00:00Z".into(); // system date never determines anniversary
    r[0].formal.as_mut().unwrap().title="".into();
    r[0].draft=Some(Snapshot {event_date:"2030-01-01".into(),title:"草稿不可展出".into(),..Default::default()});
    r[1].created_at="2026-11-12T00:00:00Z".into();
    r[6].draft=r[6].formal.take();
    r[7].status=RecordStatus::Trashed;r[7].trashed_at=Some("synthetic".into());
    r[8].museum_hidden=true;
    let state=with_rows(&s,&r);
    let page=reunion_page(&state,None,50,DAY).unwrap();
    assert_eq!(page.total,2);assert_eq!(reunion_ids(&page),vec![r[0].record_id.clone(),r[1].record_id.clone()]);
    assert_eq!(page.groups.iter().map(|g| (g.year,g.years_ago,g.label.as_str())).collect::<Vec<_>>(),
        vec![(2025,1,"1 年前的今天"),(2024,2,"2 年前的今天")]);
    assert_eq!(page.groups[0].items[0].title,"");assert!(!page.groups[0].items[0].is_future);
    let light=query::on_this_day(&state,11,12,DAY).unwrap();
    assert_eq!(light.into_iter().flat_map(|g|ids(&g.items)).collect::<Vec<_>>(),reunion_ids(&page));
    assert_eq!(home_summary(&state,DAY).unwrap().reunion_count,page.total);
    // A record created on today's month/day but occurring on another day never enters.
    let mut false_creation=dated(&["2025-06-01"]); false_creation[0].created_at=DAY.into();
    assert_eq!(reunion_page(&with_rows(&s,&false_creation),None,50,DAY).unwrap().total,0);
}

#[test]
fn reunion_leap_day_century_and_year_boundaries_do_not_shift_or_use_a_window() {
    let t=Temp::new("u011-calendar");let s=Store::open(&t.0).unwrap();
    let r=dated(&["2000-02-29","2024-02-29","2024-02-28","2024-03-01","2028-02-29","2025-12-31","2025-01-01","2026-01-01"]);
    let state=with_rows(&s,&r);
    for (today,expected) in [("2028-02-29",vec![2,1]),("2027-02-28",vec![3]),("2027-03-01",vec![4]),
        ("2026-01-01",vec![7]),("2026-12-31",vec![6]),("2100-02-28",vec![3])] {
        assert_eq!(reunion_ids(&reunion_page(&state,None,50,today).unwrap()),expected.into_iter().map(|n| format!("rec-{n:06}")).collect::<Vec<_>>(),"{today}");
    }
    assert!(reunion_page(&state,None,10,"2100-02-29").is_err());
}

#[test]
fn bounded_preview_and_all_reunion_pages_cover_every_year_and_tie() {
    let t=Temp::new("u011-reunion-pages");let s=Store::open(&t.0).unwrap();
    let mut r=synthetic_rows(203);
    for (i,r) in r.iter_mut().enumerate(){r.formal.as_mut().unwrap().event_date=format!("{}-11-12",2020+i%6);}
    let state=with_rows(&s,&r);
    let full=query::on_this_day(&state,11,12,DAY).unwrap().into_iter().flat_map(|g|ids(&g.items)).collect::<Vec<_>>();
    let first=reunion_page(&state,None,PREVIEW_LIMIT,DAY).unwrap();
    assert_eq!(reunion_ids(&first).len(),6);assert_eq!(first.total,203);assert!(first.next_cursor.is_some());
    let mut got=reunion_ids(&first);let mut cursor=first.next_cursor;
    while let Some(c)=cursor {let p=reunion_page(&state,Some(c),7,DAY).unwrap();assert_eq!(p.total,203);got.extend(reunion_ids(&p));cursor=p.next_cursor;}
    assert_eq!(got,full);assert_eq!(got.iter().collect::<BTreeSet<_>>().len(),203);
}

#[test]
fn favorites_use_b02_both_directions_and_survive_boundary_deletion() {
    let t=Temp::new("u011-favorites");let s=Store::open(&t.0).unwrap();
    let mut r=synthetic_rows(217);
    for (i,r) in r.iter_mut().enumerate(){r.favorite=true;r.museum_hidden=i%2==0; if i%3==0{photos(r,1,10000+i);}}
    r[0].status=RecordStatus::Trashed;r[0].trashed_at=Some("synthetic".into());
    r[1].draft=r[1].formal.take();
    let state=with_rows(&s,&r);
    for order in [Order::Asc,Order::Desc] {
        let expected=query::timeline_page(&state,&query::TimelineFilter{favorite_only:true,order,..Default::default()},None,500,DAY).unwrap();
        let mut cursor=None;let mut got=Vec::new();
        loop {let p=favorites_page(&state,order,cursor,11,DAY).unwrap();got.extend(ids(&p.items));cursor=p.next_cursor;if cursor.is_none(){break;}}
        assert_eq!(got,ids(&expected.items));assert_eq!(got.iter().collect::<BTreeSet<_>>().len(),215);
        assert!(expected.items.iter().any(|i|i.photo_count==0));assert!(expected.items.iter().any(|i|i.is_future));
        let first=favorites_page(&state,order,None,11,DAY).unwrap();let boundary=first.items.last().unwrap().record_id.clone();
        let changed:Vec<_>=r.iter().filter(|r|r.record_id!=boundary).cloned().collect();
        let next=favorites_page(&with_rows(&s,&changed),order,first.next_cursor,11,DAY).unwrap();
        assert_eq!(ids(&next.items),got[11..22]);
    }
}

#[test]
fn photo_wall_counts_uses_not_assets_and_keeps_formal_position_context_caption() {
    let t=Temp::new("u011-photos");let s=Store::open(&t.0).unwrap();
    let mut r=dated(&["2024-11-12","2024-11-12","2099-01-01","2020-01-01","2020-01-01"]);
    for (i,row) in r.iter_mut().enumerate(){photos(row,3,10000+i*3);}
    r[0].formal.as_mut().unwrap().title="".into();r[0].museum_hidden=true;
    r[0].draft=Some(Snapshot{title:"草稿不可见".into(),..Default::default()});
    r[3].status=RecordStatus::Trashed;r[3].trashed_at=Some("synthetic".into());r[4].draft=r[4].formal.take();
    let state=with_rows(&s,&r);
    for order in [Order::Desc,Order::Asc] {
        let sorted=query::timeline_page(&state,&query::TimelineFilter{order,..Default::default()},None,500,DAY).unwrap();
        let expected=sorted.items.iter().flat_map(|item|{
            let row=r.iter().find(|r|r.record_id==item.record_id).unwrap();
            row.formal.as_ref().unwrap().photos.iter().map(|p|p.photo_use_id.clone()).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        let mut cursor=None;let mut tiles=Vec::new();
        loop {let p=photos_page(&state,order,cursor,2,DAY).unwrap();assert_eq!(p.total,9);tiles.extend(p.items);cursor=p.next_cursor;if cursor.is_none(){break;}}
        assert_eq!(tiles.iter().map(|p|p.photo_use_id.clone()).collect::<Vec<_>>(),expected);
        assert_eq!(tiles.iter().map(|p|&p.photo_use_id).collect::<BTreeSet<_>>().len(),9);
        assert_eq!(tiles.iter().map(|p|&p.asset_id).collect::<BTreeSet<_>>().len(),1);
        for tile in tiles {
            let row=r.iter().find(|r|r.record_id==tile.record_id).unwrap();let f=row.formal.as_ref().unwrap();let p=&f.photos[tile.photo_index];
            assert_eq!(tile.caption,p.caption);assert_eq!(tile.thumbnail_key,"ast-shared.thumb-v2.png");
            assert_eq!(tile.event_date,f.event_date);assert_eq!(tile.title,(!f.title.is_empty()).then(||f.title.clone()));
            assert_eq!(tile.is_future,f.event_date.as_str()>DAY);
        }
    }
}

#[test]
fn years_are_real_month_counts_and_featured_rules_are_deterministic() {
    let t=Temp::new("u011-years");let s=Store::open(&t.0).unwrap();
    let mut r=dated(&["2024-01-01","2024-02-01","2024-02-02","2024-03-01","2024-03-02","2024-03-03","2024-04-01","2024-04-02","2099-01-01","2024-05-01","2024-05-02"]);
    r[0].favorite=true;r[1].favorite=true;
    photos(&mut r[2],2,10000);photos(&mut r[3],1,10002);photos(&mut r[7],1,10003);
    r[7].museum_hidden=true;r[7].favorite=true;r[8].favorite=true;
    r[9].draft=r[9].formal.take();r[10].status=RecordStatus::Trashed;r[10].trashed_at=Some("synthetic".into());
    let state=with_rows(&s,&r);let ys=years(&state).unwrap();
    assert_eq!(ys.iter().map(|y|y.year).collect::<Vec<_>>(),vec![2099,2024]);
    assert_eq!((ys[1].record_count,ys[1].photo_count),(8,4));
    assert_eq!(ys[1].months,[1,2,3,2,0,0,0,0,0,0,0,0]);
    let room=year_room(&state,2024,Order::Asc,None,3,DAY).unwrap();
    assert_eq!(room.summary,Some(ys[1].clone()));assert_eq!(room.page.total,8);
    assert_eq!(ids(&room.featured),[2,1,4,3,7,6].map(|n|format!("rec-{n:06}")));
    assert_eq!(ids(&room.featured),ids(&year_room(&state,2024,Order::Desc,None,5,DAY).unwrap().featured));
    let mut got=ids(&room.page.items);let mut cursor=room.page.next_cursor;
    while let Some(c)=cursor {let p=year_room(&state,2024,Order::Asc,Some(c),3,DAY).unwrap().page;got.extend(ids(&p.items));cursor=p.next_cursor;}
    assert_eq!(got,r[..8].iter().map(|r|r.record_id.clone()).collect::<Vec<_>>());
    assert!(year_room(&state,2099,Order::Desc,None,50,DAY).unwrap().featured.is_empty());
    let empty=year_room(&state,1900,Order::Desc,None,50,DAY).unwrap();
    assert!(empty.summary.is_none());assert!(empty.featured.is_empty());assert_eq!(empty.page.total,0);
}

#[test]
fn seeded_shuffle_matches_cross_language_vectors_and_avoids_minimum_repeats() {
    let t=Temp::new("u011-shuffle");let s=Store::open(&t.0).unwrap();
    let mut r=dated(&["2024-11-12";12]);
    r[8].museum_hidden=true;r[9].formal.as_mut().unwrap().event_date="2099-01-01".into();
    r[10].draft=r[10].formal.take();r[11].status=RecordStatus::Trashed;r[11].trashed_at=Some("synthetic".into());
    let state=with_rows(&s,&r);
    for (seed,want) in [(0,vec![6,3,4,1,7,5,2,8]),(1,vec![3,5,6,8,1,7,4,2]),(42,vec![5,7,6,8,2,4,3,1]),(u32::MAX,vec![6,3,7,2,5,4,1,8])] {
        let p=reshuffle(&state,seed,&[],50,DAY).unwrap();assert_eq!(p.eligible_total,8);
        assert_eq!(ids(&p.items),want.iter().map(|n|format!("rec-{n:06}")).collect::<Vec<_>>());
        let previous=ids(&p.items[..3]);let again=reshuffle(&state,seed,&previous,3,DAY).unwrap();
        assert!(ids(&again.items).iter().all(|id|!previous.contains(id)));
        let almost=ids(&p.items[..7]);let again=reshuffle(&state,seed,&almost,3,DAY).unwrap();
        assert_eq!(ids(&again.items).iter().filter(|id|almost.contains(id)).count(),2);
        r.reverse();assert_eq!(ids(&reshuffle(&with_rows(&s,&r),seed,&[],50,DAY).unwrap().items),ids(&p.items));r.reverse();
    }
}

#[test]
fn summaries_empty_single_and_read_only_queries_never_touch_originals_or_drafts() {
    let t=Temp::new("u011-read-only");let mut s=Store::open(&t.0).unwrap();
    assert_eq!(s.museum_home_summary(DAY).unwrap(),MuseumSummary::default());
    let id=s.create_draft(None,"","合成文字","2024-11-12",None).unwrap().record_id;
    photo(&mut s,&id,"shared");s.commit(&id,0).unwrap();s.set_favorite(&id,true,None).unwrap();
    s.save_draft(&id,Some("草稿标题"),Some("草稿文字"),Some("2099-01-01"),None).unwrap();
    let before=s.state_json();let disk=tree(&t.0);
    let out=s.museum_home_summary(DAY).unwrap();
    assert_eq!(out,MuseumSummary{record_count:1,reunion_count:1,favorite_count:1,photo_count:1,year_count:1,eligible_count:1,hidden_count:0});
    assert_eq!(s.museum_reunion_preview(DAY).unwrap().total,1);
    s.museum_reunion_page(None,50,DAY).unwrap();s.museum_favorites_page(Order::Desc,None,50,DAY).unwrap();
    s.museum_photos_page(Order::Desc,None,50,DAY).unwrap();s.museum_years().unwrap();
    s.museum_year_room(2024,Order::Desc,None,50,DAY).unwrap();s.museum_reshuffle(42,&[],3,DAY).unwrap();
    assert_eq!(s.state_json(),before);assert_eq!(tree(&t.0),disk);
}

#[test]
fn invalid_inputs_reject_without_panics_and_empty_pools_remain_empty() {
    let t=Temp::new("u011-invalid");let s=Store::open(&t.0).unwrap();let state=state(&s);
    for limit in [0,501] {assert!(reunion_page(&state,None,limit,DAY).is_err());assert!(favorites_page(&state,Order::Desc,None,limit,DAY).is_err());assert!(photos_page(&state,Order::Desc,None,limit,DAY).is_err());}
    for c in ["bad","[]","[\"sg11-photo\",\"bad\",-1]"] {assert!(photos_page(&state,Order::Desc,Some(c.into()),1,DAY).is_err());assert!(reunion_page(&state,Some(c.into()),1,DAY).is_err());}
    assert!(reunion_page(&state,None,1,"bad").is_err());assert!(home_summary(&state,"2026-02-29").is_err());
    assert!(year_room(&state,10000,Order::Desc,None,1,DAY).is_err());assert!(year_room(&state,-1,Order::Desc,None,1,DAY).is_err());
    assert!(reshuffle(&state,0,&[],0,DAY).is_err());assert!(reshuffle(&state,0,&[],51,DAY).is_err());
    assert!(reshuffle(&state,0,&["absent".into()],1,DAY).unwrap().items.is_empty());
    let mut r=dated(&["2024-01-01"]);r[0].formal.as_mut().unwrap().event_date="malformed".into();let broken=with_rows(&s,&r);
    assert!(home_summary(&broken,DAY).is_err());assert!(years(&broken).is_err());assert!(reunion_page(&broken,None,1,DAY).is_err());
}
