/* eslint-disable */
const fs = require( 'fs' );
const path = require( 'path' );
const pa11y = require( 'pa11y' );
const { program } = require( 'commander' );
const util = require( 'util' );

const htmlReporter = require( path.resolve( __dirname, './reporter/reporter.js' ) );
const reportTemplate = fs.readFileSync( path.resolve( __dirname, './reporter/report.mustache' ), 'utf8' );

const writeFileAsync = util.promisify( fs.writeFile );
/**
 *  Delete and recreate the report directory
 */
function resetReportDir( config ) {
	// Delete and create report directory
	if ( fs.existsSync( config.reportDir ) ) {
		fs.rmSync( config.reportDir, { recursive: true } );
	}
	fs.mkdirSync( config.reportDir, { recursive: true } );
}

// FIXME: Temporary pa11y workaround for color
// contrast errors in two groups – first valid, second
// invalid. Not suitable for production.
// Switch to axe-core for better accuracy.
function extractColorContrastInstances( data ) {
	const colorContrastInstances = [];
	let addingToArray = false;

	for ( let i = 0; i < data.issues.length; i++ ) {
		const issue = data.issues[i];

		if ( issue.code === 'color-contrast' ) {
			if ( !addingToArray ) {
				// Start adding to the array
				addingToArray = true;
			}
			// Add the current issue to the array
			colorContrastInstances.push( issue );
		} else if ( addingToArray && i > 0 && data.issues[i].code !== 'color-contrast' && data.issues[i - 1].code === 'color-contrast' ) {
			// Break the loop if a different code value is encountered after adding to the array
			addingToArray = false;
			break;
		}
	}

	return colorContrastInstances;
}

/**
 *  Get array of promises that run accessibility tests using pa11y
 *
 * @param {Object[]} tests
 * @param {Object} config
 * @return {Promise<any>[]}
 */
function getTestPromises( tests, config ) {
	const options = config.defaults; // Common options for all tests

	// Use a single listener for all tests
	process.setMaxListeners( 100 );

	return tests.map( ( test ) => {
		const { url, name, ...testOptions } = test;
		const testConfig = { ...options, ...testOptions };

		return pa11y( url, testConfig ).then( ( testResult ) => {
			testResult.name = name;
			return testResult;
		} );
	} );
}

/**
 *  Process test results, log the results to console and a CSV.
 *
 * @param {Object[]} testResult
 */
async function processTestResult( testResult, config, opts ) {
	const colorContrastErrList = extractColorContrastInstances( testResult );
	const colorContrastErrorNum = colorContrastErrList.length;
	const name = testResult.name;

	// Log color contrast errors summary to console.
	if ( !opts.silent && colorContrastErrorNum > 0 ) {
		console.log( `'${name}' - ${colorContrastErrorNum} color contrast violations` );
		const simplifiedList = colorContrastErrList.map( ( { selector, context } ) => ( { selector, context } ) );

		return { simplifiedList, colorContrastErrorNum }; // Return both the simplifiedList and colorContrastErrorNum
	}

	console.log( `'${name}' - ${colorContrastErrorNum} color contrast violations` );

	return { simplifiedList: [], colorContrastErrorNum }; // Return empty list and error count if no errors
}


require( 'dotenv' ).config();
const getConfig = require( './a11y.config.js' );


/**
 *  Run pa11y on tests specified by the config.
 *
 * @param {Object} opts
 */
async function runTests( opts ) {
	if (
		!process.env.MW_SERVER
	) {
		throw new Error( 'Missing env variable. Please run `export MW_SERVER=https://en.wikipedia.org`' );
	}

	const getConfigFunction = getConfig(); // Invoking the exported function
	const config = await getConfigFunction; // Getting the actual resolved value of the promise
	if ( !config || !config.tests || !config.reportDir ) {
		throw new Error( 'Missing config variables' );
	}

	const tests = config.tests;
	const allValidTests = tests.filter( ( test ) => test.name ).length === tests.length;
	if ( !allValidTests ) {
		throw new Error( 'Config missing test name' );
	}

	resetReportDir( config );

	const testPromises = getTestPromises( tests, config );
	const results = await Promise.all( testPromises );
	let totalErrors = 0; // Variable to keep track of total errors

	// Accumulate all simplifiedLists
	const allSimplifiedLists = [];

	// Use a for...of loop to properly await the promises
	for ( const result of results ) {
		const { simplifiedList, colorContrastErrorNum } = await processTestResult( result, config, opts );
		totalErrors += colorContrastErrorNum;

		const name = result.name; // Get the name from the test result

		allSimplifiedLists.push( { name, simplifiedList } ); // Include name in the array
	}

	// Log the final count of errors
	console.log( `Total errors across all tests: ${totalErrors}` );

	// Write all simplifiedLists to a CSV file
	const flattenedList = allSimplifiedLists.flatMap( ( item ) =>
		item.simplifiedList.map( ( { selector, context } ) => ( { name: item.name, selector, context } ) )
	);

	// Generate HTML report
	async function generateHtmlReport( flattenedList, reportTemplate, reportDir ) {
		const html = await htmlReporter.results( flattenedList, reportTemplate );
		await fs.promises.writeFile( `${reportDir}/report.html`, html, 'utf8' );
	}

	// Copy JS across
	fs.copyFileSync( 'reporter/index.js', 'a11y/index.js' );

	// Save in html report
	await generateHtmlReport( flattenedList, reportTemplate, config.reportDir );

	// Save in a .csv
	await writeSimplifiedListToCSV( flattenedList, config.reportDir, 'simplifiedList.csv' );
}

/**
 * @param {any[]} simplifiedList
 * @param {string} reportDir
 * @param {string} fileName
 */
async function writeSimplifiedListToCSV( simplifiedList, reportDir, fileName ) {
	const csvContent = simplifiedList
		.map( ( { name, selector, context } ) => `"${name}","${selector}","${context}"` )
		.join( '\n' );

	// Use path.join to concatenate directory paths
	const filePath = path.join( reportDir, fileName );

	await writeFileAsync( filePath, 'Name,Selector,Context\n' + csvContent );
	console.log( `SimplifiedList written to ${filePath}` );
}

function init() {
	program
		.option( '-c, --config <path>', 'path to config file to use', './a11y.config.js' )
		.action( ( opts ) => {
			runTests( opts );
		} );

	program.parse();
}

init();
