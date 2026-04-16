import m0000 from './0000_even_turbo.sql';
import m0001 from './0001_lonely_wallop.sql';
import m0002 from './0002_project_think.sql';
import journal from './meta/_journal.json';

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
