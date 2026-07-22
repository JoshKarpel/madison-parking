// Addresses are the city's official garage addresses (all Madison, WI 53703).
// placeCid is the garage's Google Maps place CID: the map link points at the
// named place when present, falling back to an address search when absent.
// lat/lon are the garage's coordinates (geocoded from the address); the client
// uses them to match nearby venue events to a garage (site/events.js).
export const GARAGES = {
  1:  { name: "Overture Center",      address: "318 W. Mifflin St., Madison, WI 53703", placeCid: "816693333906503110",   lat: 43.073236, lon: -89.388706, note: "Near the Overture Center & Library" },
  2:  { name: "State Street Capitol", address: "200 N. Carroll St., Madison, WI 53703", placeCid: "17614130343263191444", lat: 43.075413, lon: -89.387488, note: "Near Ian's Pizza" },
  5:  { name: "State Street Campus",  address: "430 N. Frances St., Madison, WI 53703", placeCid: "2941521743882134071",  lat: 43.073759, lon: -89.395922, note: "Near Estacion Inka" },
  6:  { name: "Capitol Square North", address: "218 E. Mifflin St., Madison, WI 53703", placeCid: "5807581524301936228",  lat: 43.077208, lon: -89.383065, note: "Near Heritage Tavern" },
  18: { name: "South Livingston St",  address: "111 S. Livingston St., Madison, WI 53703", placeCid: "16188105830359944411", lat: 43.080032, lon: -89.373120, note: "Near The Sylvee" },
  19: { name: "Wilson Street",        address: "20 E. Wilson St., Madison, WI 53703", placeCid: "1288768444224742157",  lat: 43.072807, lon: -89.381124, note: "Near Monona Terrace" },
};
