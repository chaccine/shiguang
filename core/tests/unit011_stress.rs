//! Same synthetic_rows generator and 32 shared small PNGs as unit08_stress.
//! Debug budgets are regression guards, not device or large-original benchmarks.
mod unit05_support;
mod unit07_support;
use shiguang_core::{json::Json,Order,Store};
use std::{fs,time::Instant};
use unit07_support::*;

fn timed<'a,T>(name:&'a str,report:&mut Vec<(&'a str,Json)>,f:impl FnOnce()->T)->T{
    let start=Instant::now();let out=f();let elapsed=start.elapsed();
    println!("museum {name}: {:.3} ms",elapsed.as_secs_f64()*1000.);
    report.push((name,Json::str(format!("{:.3}",elapsed.as_secs_f64()*1000.))));
    assert!(elapsed.as_millis()<150,"{name}: {elapsed:?} exceeds generous 150 ms debug budget");out
}
#[test]
fn five_thousand_records_each_first_page_is_bounded_without_persisted_views() {
    let t=Temp::new("u011-stress");let mut seed=Store::open(&t.0).unwrap();let id=draft(&mut seed,"合成照片种子");
    let originals:Vec<_>=(0..32).map(|i|photo(&mut seed,&id,&format!("synthetic-{i}"))).collect();
    let mut rows=synthetic_rows(5000);
    for (i,r) in rows.iter_mut().enumerate(){
        let mut p=originals[i%32].clone();p.photo_use_id=format!("pu-{:06}",10000+i);
        let f=r.formal.as_mut().unwrap();f.cover_photo_use_id=Some(p.photo_use_id.clone());f.photos.push(p);
        if i%100==0{f.event_date="2024-11-12".into();}
        r.favorite=i%5==0;r.museum_hidden=i%37==0;
    }
    let state=with_rows(&seed,&rows);let snapshot=state.to_json(seed.seed()).dump();drop(seed);fs::write(t.0.join("state.json"),&snapshot).unwrap();
    let s=Store::open(&t.0).unwrap();let before=s.state_json();let mut timings=Vec::new();let today="2026-11-12";
    let home=timed("homeSummary",&mut timings,||s.museum_home_summary(today).unwrap());assert_eq!(home.record_count,5000);assert_eq!(home.photo_count,5000);
    let preview=timed("reunionPreview",&mut timings,||s.museum_reunion_preview(today).unwrap());assert_eq!(preview.groups.iter().map(|g|g.items.len()).sum::<usize>(),6);assert!(preview.total>6);
    timed("reunionPage",&mut timings,||s.museum_reunion_page(None,50,today).unwrap());
    let favorites=timed("favoritesFirst",&mut timings,||s.museum_favorites_page(Order::Desc,None,50,today).unwrap());assert_eq!(favorites.items.len(),50);
    let photos=timed("photosFirst",&mut timings,||s.museum_photos_page(Order::Desc,None,50,today).unwrap());assert_eq!(photos.items.len(),50);assert_eq!(photos.total,5000);
    timed("photosNext",&mut timings,||s.museum_photos_page(Order::Desc,photos.next_cursor,50,today).unwrap());
    timed("years",&mut timings,||s.museum_years().unwrap());
    let room=timed("yearRoomFirst",&mut timings,||s.museum_year_room(2024,Order::Desc,None,50,today).unwrap());assert_eq!(room.page.items.len(),50);assert_eq!(room.featured.len(),6);
    timed("reshuffle",&mut timings,||s.museum_reshuffle(42,&[],6,today).unwrap());
    assert_eq!(s.state_json(),before);assert_eq!(fs::read(t.0.join("state.json")).unwrap(),snapshot.as_bytes());assert_eq!(fs::read_dir(t.0.join("previews")).unwrap().count(),0);
    let report=Json::obj(vec![("records",Json::Num(5000)),("photoUses",Json::Num(5000)),("uniqueSyntheticPhotos",Json::Num(32)),
        ("stateBytes",Json::Num(snapshot.len() as i64)),("timingsMs",Json::obj(timings))]).dump();println!("{report}");
    if let Ok(path)=std::env::var("SHIGUANG_MUSEUM_STRESS_OUT"){fs::write(path,format!("{report}\n")).unwrap();}
}
